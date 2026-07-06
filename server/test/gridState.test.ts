import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGridBackstop,
  computeGridImportWatts,
  computeHomeGridWatts,
  interpretGridEntity,
  downgradePriorityForGrid,
} from '../src/gridState.js';

/* ===================================================================
 * v0.23.0 — the grid-backstop resolver is safety-critical: a false
 * "grid is fine" can silence a real off-grid emergency at the reserve
 * floor. These tests pin the safe-default posture and the re-escalation
 * guard across the full off-grid / live-import / declared matrix.
 * =================================================================== */

// Minimal device fixtures — the resolver only reads kind/online/sn/acInWatts on
// DPUs and the SHP2's sources[].sn + chargeWattPower.
function dpu(sn: string, acInWatts: number, online = true): any {
  return { sn, online, productName: 'Delta Pro Ultra', projection: { kind: 'dpu', acInWatts } };
}
function shp2(sourceSns: (string | null)[], chargeWattPower: number | null, gridWatt: number | null = null): any {
  return {
    sn: 'SHP2',
    online: true,
    productName: 'Smart Home Panel 2',
    projection: { kind: 'shp2', chargeWattPower, gridWatt, sources: sourceSns.map((sn, i) => ({ slot: i + 1, sn })) },
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

test('live grid import alone proves present AND backstopping (no declaration needed)', () => {
  const devices = fleet(shp2(['A', 'B'], -1200 /* even discharging */), dpu('A', 600), dpu('B', 200));
  const g = resolveGridBackstop({ devices, ...NO_DECL });
  assert.equal(g.importWatts, 800);
  assert.equal(g.importLive, true);
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true, 'live import is definitive — overrides a discharging pool');
});

test('GRID_AVAILABLE fallback declares present; pool charging → backstopping', () => {
  const devices = fleet(shp2(['A'], 7200 /* charging */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true });
  assert.equal(g.declared, true);
  assert.equal(g.present, true);
  assert.equal(g.backstopping, true);
});

test('declared present but pool DISCHARGING → re-escalation guard: NOT backstopping', () => {
  const devices = fleet(shp2(['A'], -300 /* discharging > 50 W */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true });
  assert.equal(g.present, true, 'nominally present (declared)');
  assert.equal(g.backstopping, false, 'declared grid not carrying the load at the floor → stay critical');
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

test('home-grid flow overrides a declared-but-discharging pool (measured flow is definitive)', () => {
  // chargeWattPower −300 would trip the best-effort discharge guard, but a measured
  // gridWatt proves the grid IS carrying the home → must stay backstopping.
  const devices = fleet(shp2(['A'], -300, 5000 /* gridWatt */), dpu('A', 0));
  const g = resolveGridBackstop({ devices, ...NO_DECL, gridAvailableFallback: true });
  assert.equal(g.importLive, true);
  assert.equal(g.backstopping, true, 'live home-grid flow overrides the chargeWattPower discharge guard');
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
