import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGridBackstop,
  computeGridImportWatts,
  computeHomeGridWatts,
  computeShp2GridConnected,
  interpretGridEntity,
  downgradePriorityForGrid,
} from '../src/gridState.js';

/* ===================================================================
 * v0.23.0 — the grid-backstop resolver is safety-critical: a false
 * "grid is fine" can silence a real off-grid emergency at the reserve
 * floor. These tests pin the safe-default posture and the re-escalation
 * guard across the full off-grid / live-import / declared matrix.
 * =================================================================== */

// Minimal device fixtures — the resolver reads kind/online/sn/acInWatts + per-pack
// flow on DPUs and the SHP2's sources[].sn.
// v0.98.0 — poolDischarging is now driven by the LIVE per-pack net (aggregateFleetFlow.
// fleetBatteryNet), NOT chargeWattPower's sign. packNetW: >0 = discharging (outputWatts),
// <0 = charging (inputWatts), 0 = idle. chargeWattPower is retained on the SHP2 fixture only
// to prove it is IGNORED by the guard.
function dpu(sn: string, acInWatts: number, online = true, packNetW = 0): any {
  const packs = [{ inputWatts: packNetW < 0 ? -packNetW : 0, outputWatts: packNetW > 0 ? packNetW : 0 }];
  return { sn, online, productName: 'Delta Pro Ultra', projection: { kind: 'dpu', acInWatts, packs } };
}
function shp2(
  sourceSns: (string | null)[],
  chargeWattPower: number | null,
  gridWatt: number | null = null,
  gridConnected: boolean | null = null, // v0.89.0 — pd303_mc.masterIncreInfo.gridSta (value-1-only)
  online = true,
): any {
  return {
    sn: 'SHP2',
    online,
    productName: 'Smart Home Panel 2',
    // v0.98.0 — circuits: [] so aggregateFleetFlow's panelLoad loop (now reached via the
    // live poolDischarging path) doesn't crash; panelLoad is unused by resolveGridBackstop.
    projection: { kind: 'shp2', chargeWattPower, gridWatt, gridConnected, circuits: [], sources: sourceSns.map((sn, i) => ({ slot: i + 1, sn })) },
  };
}
function fleet(...devs: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of devs) out[d.sn] = d;
  return out;
}

const NO_DECL = { gridEntity: null, gridEntityConfigured: false, gridAvailableFallback: false };

test('off-grid (no entity, GRID_AVAILABLE false, no import) → not present, not backstopping', () => {
  const devices = fleet(shp2(['A', 'B'], 7200), dpu('A', 0), dpu('B', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.present, false);
  assert.equal(g.backstopping, false);
  assert.equal(g.importLive, false);
  assert.equal(g.declared, false);
});

test('live grid import alone proves present AND backstopping — even at the floor with a discharging pool', () => {
  // A+B discharging 1100 W (per-pack) AT the reserve floor — importLive is still definitive.
  const devices = fleet(shp2(['A', 'B'], 0), dpu('A', 600, true, 700), dpu('B', 200, true, 400));
  const g = resolveGridBackstop({ devices, ...NO_DECL, atReserveFloor: true });
  assert.equal(g.importWatts, 800);
  assert.equal(g.importLive, true);
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true, 'live import is definitive — overrides a discharging pool even at the floor');
});

test('GRID_AVAILABLE fallback declares present; pool charging → backstopping', () => {
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0, true, -500 /* charging */));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true });
  assert.equal(g.declared, true);
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true);
});

test('declared present but pool DISCHARGING AT THE FLOOR → re-escalation guard: NOT backstopping', () => {
  // v0.98.0 — the guard is now LIVE (per-pack 300 W discharge) AND floor-scoped. chargeWattPower
  // is +7200 (a real, non-negative charge limit) — proving the guard no longer reads its sign.
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0, true, 300 /* discharging > 50 W */));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true });
  assert.equal(g.present, true, 'nominally present (declared)');
  assert.equal(g.backstopping, false, 'declared grid not carrying the load at the floor → stay critical');
});

test('v0.98.0 — declared + pool discharging but AWAY FROM THE FLOOR → STILL backstopping (no self-consumption nuisance)', () => {
  // Same discharging pool, NOT at the reserve floor: normal battery-priority cycling must NOT
  // withhold the declared-grid backstop (else a self-consumption home escalates every evening).
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0, true, 300));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: false });
  assert.equal(g.declared, true);
  assert.equal(g.backstopping, true, 'away from the floor a discharging pool is normal cycling — backstop preserved');
});

test('v0.98.0 — the guard reads the LIVE per-pack net, NOT chargeWattPower: gridSta=OK + CHARGING packs at the floor → backstopping', () => {
  // The old dead guard keyed off chargeWattPower<-50 (never true). Here chargeWattPower is +7200
  // and the pack is CHARGING (net -400) at the floor → pool is NOT discharging → the gridSta
  // backstop holds. (gridSta is used so floorWithoutFlow doesn't mask the poolDischarging path;
  // its DISCHARGING counterpart is the v0.89.0 #7 WEDGE test, which now flips to NOT backstopping.)
  const devices = fleet(shp2([null], 7200, 0, true /* gridSta OK */, true), dpu('A', 0, true, -400 /* charging */));
  const g = resolveGridBackstop({ devices, ...NO_DECL, atReserveFloor: true });
  assert.equal(g.backstopping, true, 'a charging pool at the floor is a real backstop — chargeWattPower sign is irrelevant');
});

test('configured entity ON → present; OFF / unavailable / unknown / empty → NOT present (safe)', () => {
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0));
  const on = resolveGridBackstop({ devices, gridEntity: { state: 'on' } as any, gridEntityConfigured: true, gridAvailableFallback: false });
  assert.equal(on.declared, true);
  assert.equal(on.backstopping, true);
  for (const s of ['off', 'unavailable', 'unknown', '']) {
    const g = resolveGridBackstop({ devices, gridEntity: { state: s } as any, gridEntityConfigured: true, gridAvailableFallback: false });
    assert.equal(g.declared, false, `state '${s}' must NOT declare grid present`);
    assert.equal(g.present, false, `state '${s}' must resolve to off-grid`);
  }
});

test('a configured entity is authoritative — overrides GRID_AVAILABLE fallback', () => {
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0));
  const g = resolveGridBackstop({ devices, gridEntity: { state: 'off' } as any, gridEntityConfigured: true, gridAvailableFallback: true });
  assert.equal(g.declared, false, 'entity off wins over GRID_AVAILABLE true');
  assert.equal(g.present, false);
});

test('interpretGridEntity: on/voltage → true; off/0 → false; unavailable/null → null', () => {
  assert.equal(interpretGridEntity({ state: 'on' } as any), true);
  assert.equal(interpretGridEntity({ state: 'home' } as any), true);
  assert.equal(interpretGridEntity({ state: '241.7' } as any), true);
  assert.equal(interpretGridEntity({ state: '0' } as any), false);
  assert.equal(interpretGridEntity({ state: 'off' } as any), false);
  assert.equal(interpretGridEntity({ state: 'unavailable' } as any), null);
  assert.equal(interpretGridEntity({ state: '' } as any), null);
  assert.equal(interpretGridEntity(null), null);
});

test('computeGridImportWatts scopes to SHP2-bound cores (excludes self-charging spare)', () => {
  // sources = A,B; spare C plugged into a wall (acIn 1500) must NOT count.
  const devices = fleet(shp2(['A', 'B'], 7200), dpu('A', 300), dpu('B', 200), dpu('C', 1500));
  assert.equal(computeGridImportWatts(devices), 500);
});

test('downgradePriorityForGrid collapses emergency tiers only when backstopping', () => {
  assert.equal(downgradePriorityForGrid('critical', true), 'low');
  assert.equal(downgradePriorityForGrid('high', true), 'low');
  assert.equal(downgradePriorityForGrid('medium', true), 'medium');
  assert.equal(downgradePriorityForGrid('low', true), 'low');
  assert.equal(downgradePriorityForGrid('critical', false), 'critical');
  assert.equal(downgradePriorityForGrid('high', false), 'high');
});

test('SHP2 with unknown (all-null) source SNs must NOT count a wall-charging spare as grid import', () => {
  // Real off-grid: SHP2 source SNs missing (partial /quota/all), pool discharging,
  // a spare DPU self-charging at 1500 W. The spare must NOT mask the emergency.
  const devices = fleet(shp2([null, null], -2000), dpu('SPARE', 1500));
  assert.equal(computeGridImportWatts(devices), 0, 'no source identity ⇒ 0 import, not the spare 1500 W');
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.importLive, false);
  assert.equal(g.present, false);
  assert.equal(g.backstopping, false, 'genuine off-grid floor emergency stays critical');
});

test('a STALE configured grid entity is treated as UNKNOWN, never its frozen value', () => {
  const devices = fleet(shp2(['A'], 7200), dpu('A', 0));
  const fresh = resolveGridBackstop({ devices, gridEntity: { state: 'on' } as any, gridEntityConfigured: true, gridAvailableFallback: false });
  assert.equal(fresh.declared, true, 'fresh on → present');
  const stale = resolveGridBackstop({ devices, gridEntity: { state: 'on' } as any, gridEntityConfigured: true, gridAvailableFallback: false, gridEntityStale: true });
  assert.equal(stale.declared, false, 'stale on must NOT declare grid present (HA unreachable ⇒ unknown)');
  assert.equal(stale.present, false);
  assert.equal(stale.backstopping, false);
});

/* ===================================================================
 * v0.36.0 — SHP2 home-grid (gridWatt) path. The resolver must recognise
 * grid that backstops the home DIRECTLY through the panel (DPU ac_in 0) —
 * the path the DPU-ac_in sum is blind to. Verified against the real
 * 2026-06-20 overnight backstop (+32.7 kWh home-grid, 0 DPU ac_in).
 * =================================================================== */

test('SHP2 home-grid flow (gridWatt) alone proves present AND backstopping — the at-floor backstop DPU ac_in misses', () => {
  // Overnight 2026-06-20 shape: battery at the 10% floor, DPU ac_in = 0 (grid is
  // NOT charging the DPUs), but the SHP2 pulled grid to carry the home
  // (gridWatt ~4.7 kW). No declaration needed — measured home-grid flow is definitive.
  const devices = fleet(shp2(['A'], 0, 4700 /* gridWatt */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.homeGridWatts, 4700);
  assert.equal(g.importWatts, 0, 'DPU ac_in path is blind to the home-grid backstop');
  assert.equal(g.importLive, true, 'SHP2 gridWatt IS live grid flow');
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true, 'measured home-grid flow backstops the floor without needing the toggle');
});

test('home-grid flow overrides a declared-but-discharging pool at the floor (measured flow is definitive)', () => {
  // A discharging pool (per-pack 300 W) AT the floor would trip the re-escalation guard, but a
  // measured gridWatt proves the grid IS carrying the home → must stay backstopping.
  const devices = fleet(shp2(['A'], 7200, 5000 /* gridWatt */), dpu('A', 0, true, 300));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true });
  assert.equal(g.importLive, true);
  assert.equal(g.backstopping, true, 'live home-grid flow overrides the pool-discharge guard');
});

test('neither grid path flowing + no declaration → off-grid (home-grid path never fabricates presence)', () => {
  const devices = fleet(shp2(['A'], -300, 0 /* gridWatt 0 */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.homeGridWatts, 0);
  assert.equal(g.importLive, false);
  assert.equal(g.present, false);
  assert.equal(g.backstopping, false);
});

test('tiny home-grid noise below HOME_GRID_IMPORT_WATTS does NOT count as live', () => {
  const devices = fleet(shp2(['A'], -300, 10 /* below the 25 W threshold */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.importLive, false, '10 W is below the home-grid threshold');
  assert.equal(g.backstopping, false, 'no declaration + sub-threshold flow + discharging → off-grid');
});

test('computeHomeGridWatts: positive gridWatt only; null/negative/non-finite/no-SHP2 → 0', () => {
  assert.equal(computeHomeGridWatts(fleet(shp2(['A'], 0, 4700))), 4700);
  assert.equal(computeHomeGridWatts(fleet(shp2(['A'], 0, 0))), 0);
  assert.equal(computeHomeGridWatts(fleet(shp2(['A'], 0, null))), 0);
  assert.equal(computeHomeGridWatts(fleet(shp2(['A'], 0, -50))), 0, 'negative gridWatt (export/noise) contributes nothing');
  assert.equal(computeHomeGridWatts(fleet(dpu('A', 600))), 0, 'no SHP2 device → 0');
});

test('v0.88.0 — an OFFLINE SHP2 contributes 0 home-grid watts (frozen gridWatt must NOT mute a real at-floor outage)', () => {
  // A cloud-offline SHP2 freezes its last gridWatt in the projection. Unguarded,
  // a frozen-high value (e.g. the 8 kW it pulls at the floor) would keep
  // importLive=true → backstopping=true → mute a REAL outage that begins during
  // the offline window. The online-gate mirrors the DPU ac_in path.
  const offlineShp2 = { ...shp2(['A'], -300, 8000), online: false };
  assert.equal(computeHomeGridWatts(fleet(offlineShp2)), 0, 'offline SHP2: stale gridWatt contributes nothing');
  // Sanity: the SAME device online still reports its 8 kW (no regression to the live path).
  assert.equal(computeHomeGridWatts(fleet(shp2(['A'], -300, 8000))), 8000);
  // End-to-end: an offline SHP2 at the reserve floor with a frozen-high gridWatt +
  // a declared grid must NOT backstop (no importLive from the stale sample; the
  // discharging pool at the floor keeps it critical) — the outage stays audible.
  const g = resolveGridBackstop({
    devices: fleet(offlineShp2), ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true,
  });
  assert.equal(g.importLive, false, 'offline SHP2 gridWatt no longer asserts live import');
  assert.equal(g.backstopping, false, 'a real at-floor outage during SHP2 cloud-offline is NOT muted');
});

/* ===================================================================
 * v0.89.0 — the SHP2's OWN direct grid-presence flag (gridSta=Grid OK,
 * pd303_mc.masterIncreInfo.gridSta, VALUE-1-ONLY, online-gated). Additive
 * backstop signal that closes the between-burst false at-floor critical
 * WITHOUT muting a real outage: exempt from floorWithoutFlow (burst-gap
 * immunity) but SUBJECT to poolDischarging (no wedged/stale mute).
 * =================================================================== */

test('computeShp2GridConnected: online passes gridConnected through; offline ⇒ null; no-SHP2 ⇒ null', () => {
  assert.equal(computeShp2GridConnected(fleet(shp2([null], 0, 0, true, true))), true);
  assert.equal(computeShp2GridConnected(fleet(shp2([null], 0, 0, false, true))), false);
  assert.equal(computeShp2GridConnected(fleet(shp2([null], 0, 0, null, true))), null);
  assert.equal(computeShp2GridConnected(fleet(shp2([null], 0, 8000, true, false))), null, 'OFFLINE SHP2: frozen gridSta must not assert presence');
  assert.equal(computeShp2GridConnected(fleet(dpu('A', 600))), null, 'no SHP2 device → null');
});

test('v0.89.0 #1 — gridSta=Grid OK in a burst gap at the floor (pool NOT discharging) → backstopping (the core false-critical fix)', () => {
  // gridWatt momentarily 0, no DPU ac-in, no declared entity, pool AT reserve floor,
  // charge paused (cwp=0). Pre-v0.89 this was off-grid/critical; now gridSta downgrades it.
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], 0, 0, true, true)), ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.importLive, false, 'no measured flow this instant');
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true, 'SHP2 gridSta=Grid OK holds the floor through the burst gap');
  assert.match(g.reason, /grid connected/);
});

test('v0.89.0 #2/#6 — gridSta NOT Grid OK (0 or 2), no flow, no declared → off-grid, critical stays', () => {
  // gridConnected=false represents BOTH gridSta=0 (grid gone) and gridSta=2 (energized
  // but out-of-spec → SHP2 islands onto battery — NOT a safe backstop). Neither backstops.
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], -300, 0, false, true)), ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.present, false);
  assert.equal(g.backstopping, false, 'a real/islanded outage is not muted');
});

test('v0.89.0 #3 — gridSta=Grid OK but SHP2 OFFLINE (frozen) → not present, not backstopping', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], -300, 8000, true, false)), ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.shp2GridConnected, null, 'offline ⇒ gridSta signal withheld');
  assert.equal(g.backstopping, false, 'frozen-offline gridSta cannot mute an at-floor outage');
});

test('v0.89.0 #4 — gridSta=null (older firmware) does NOT break the existing gridWatt import path', () => {
  const g = resolveGridBackstop({ devices: fleet(shp2([null], 0, 5000, null, true)), ...NO_DECL });
  assert.equal(g.importLive, true, 'homeGridWatts=5000 still proves live import');
  assert.equal(g.backstopping, true);
});

test('v0.89.0 #5 — gridSta=null + declared + at floor + no flow → still withheld (floorWithoutFlow intact)', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], -300, 0, null, true)), ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true,
  });
  assert.equal(g.present, true, 'declared toggle still marks present');
  assert.equal(g.backstopping, false, 'a null gridSta must not accidentally satisfy the flag path');
});

test('v0.89.0 #7 — WEDGE: gridSta=Grid OK but pool NET-DISCHARGING at floor → present but NOT backstopping', () => {
  // The poolDischarging guard applies to the gridSta term too: a stale/wedged "connected"
  // while the pool net-discharges past the floor is treated as no real backstop. v0.98.0 — the
  // discharge is a LIVE per-pack net (300 W) and the guard is floor-scoped (atReserveFloor).
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], 0, 0, true, true), dpu('A', 0, true, 300)), ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.present, true);
  assert.equal(g.backstopping, false, 'net-discharging pool at the floor withholds the gridSta backstop');
  assert.match(g.reason, /still discharging/);
});

test('v0.89.0 #8 — gridSta=Grid OK + a wall-charging SPARE DPU (not an SHP2 source) → present from gridSta, spare scoping unregressed', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2([null], 0, 0, true, true), dpu('SPARE', 600)), ...NO_DECL,
  });
  assert.equal(g.importWatts, 0, 'spare DPU ac-in still excluded (not an SHP2 source)');
  assert.equal(g.backstopping, true, 'present comes from gridSta, not the spare');
});

/* ===================================================================
 * v0.36.0 — FLOOR-HARDENING. AT the reserve floor, a DECLARED grid with
 * NO measured flow on EITHER path (DPU ac_in AND SHP2 gridWatt both 0)
 * must NOT backstop — a stale "grid available" toggle must not mute a
 * real at-floor outage. AWAY from the floor, a flow-less declaration
 * stays a valid backstop (grid available, not yet needed).
 * =================================================================== */

test('AT floor + declared(fallback) + NO measured flow + pool NOT discharging → NOT backstopping (stale-toggle protection)', () => {
  // chargeWattPower 0 ⇒ poolDischarging is false, so this proves the floor-
  // hardening fires on its own — NOT the best-effort discharge guard.
  const devices = fleet(shp2(['A'], 0, 0), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true });
  assert.equal(g.declared, true, 'still nominally declared present');
  assert.equal(g.present, true);
  assert.equal(g.importLive, false, 'no measured flow on either path');
  assert.equal(g.backstopping, false, 'stale toggle at the floor with no flow must NOT mute the outage');
});

test('AT floor + declared + live home-grid flow (gridWatt) → STILL backstopping (normal at-floor backstop not falsely escalated)', () => {
  const devices = fleet(shp2(['A'], 0, 5000), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: true });
  assert.equal(g.importLive, true, 'measured home-grid flow IS live');
  assert.equal(g.backstopping, true, 'measured flow at the floor is a real backstop — not escalated');
});

test('NOT at floor + declared + no flow → STILL backstopping (pre-floor grid-available downgrade PRESERVED — regression guard)', () => {
  const devices = fleet(shp2(['A'], 0, 0), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true, atReserveFloor: false });
  assert.equal(g.declared, true);
  assert.equal(g.backstopping, true, 'away from the floor a flow-less declaration stays a valid backstop');
});
