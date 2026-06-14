import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGridBackstop,
  computeGridImportWatts,
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
function shp2(sourceSns: (string | null)[], chargeWattPower: number | null): any {
  return {
    sn: 'SHP2',
    online: true,
    productName: 'Smart Home Panel 2',
    projection: { kind: 'shp2', chargeWattPower, sources: sourceSns.map((sn, i) => ({ slot: i + 1, sn })) },
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
