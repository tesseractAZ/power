import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v0.43.0 — Alerts-page accuracy audit.
 *
 * (1) grid-offgrid must use the grid-presence RESOLVER (`grid.present`), not the
 *     obsolete DPU acIn<5 sum — which read 0 (and falsely fired "Running off-grid")
 *     on a grid-tied home whenever PV/battery covered DPU charging while the grid
 *     carried home load through the SHP2 main.
 * (2) shp2-near-reserve must be grid-aware like shp2-below-reserve: warning→info
 *     while the grid backstops; a real outage keeps it warning.
 */

const now = Date.now();
const dpuProjection = {
  kind: 'dpu', soc: 95, packs: [],
  pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
  pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
  pvHighErrCode: 0, pvLowErrCode: 0,
  acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
  batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
  splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
  sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
  chgMaxSoc: 100, dsgMinSoc: 10,
};
function dpu(sn: string, over: Partial<typeof dpuProjection> = {}): DeviceSnapshot {
  return {
    sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'Delta Pro Ultra', online: true, lastUpdated: now,
    projection: { ...dpuProjection, ...over } as any,
  } as DeviceSnapshot;
}
function shp2(backupBatPercent: number | null, backupReserveSoc = 10): DeviceSnapshot {
  return {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now,
    projection: { kind: 'shp2', backupBatPercent, backupReserveSoc, sources: [], pairedCircuits: [] } as any,
  } as DeviceSnapshot;
}
const devices = (...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> =>
  Object.fromEntries(arr.map((d) => [d.sn, d]));
const offgrid = (a: Alert[]) => a.find((x) => x.id === 'grid-offgrid');
const nearReserve = (a: Alert[]) => a.find((x) => x.id === 'shp2-near-reserve');

/* ─── (1) off-grid via the resolver ─────────────────────────────────── */

test('grid-offgrid SUPPRESSED when the resolver says the grid is present (the live false-alert case)', () => {
  // acIn=0 (DPU charging covered by PV/battery) would have falsely fired the old heuristic;
  // the resolver knows the grid is present (carrying home load through the SHP2 main).
  const alerts = computeAlerts(devices(dpu('SN-1')), undefined, { present: true, backstopping: true });
  assert.equal(offgrid(alerts), undefined, 'present grid ⇒ no "Running off-grid" alert');
});

test('grid-offgrid FIRES when the resolver says the grid is absent (a real outage)', () => {
  const alerts = computeAlerts(devices(dpu('SN-1')), undefined, { present: false, backstopping: false });
  assert.ok(offgrid(alerts), 'absent grid ⇒ off-grid alert present');
  assert.equal(offgrid(alerts)!.severity, 'info');
});

test('grid-offgrid falls back to acIn<5 when grid is omitted (safe default = off-grid)', () => {
  const alerts = computeAlerts(devices(dpu('SN-1', { acInWatts: 0 }))); // no grid arg
  assert.ok(offgrid(alerts), 'omitted grid + acIn<5 ⇒ off-grid (safe default)');
});

/* ─── (2) near-reserve is grid-aware ────────────────────────────────── */

test('shp2-near-reserve DOWNGRADES warning→info while the grid backstops', () => {
  // 14% pool, 10% reserve → within reserve+10 (near-reserve band). Grid present + backstopping.
  const alerts = computeAlerts(devices(shp2(14, 10)), undefined, { present: true, backstopping: true });
  const a = nearReserve(alerts);
  assert.ok(a, 'near-reserve alert present at 14% (reserve 10%)');
  assert.equal(a!.severity, 'info', 'grid backstopping ⇒ downgraded to info');
});

test('shp2-near-reserve stays warning during a real outage (grid not backstopping)', () => {
  // present:false so the off-grid path is consistent; backstopping:false ⇒ no downgrade.
  const alerts = computeAlerts(devices(shp2(14, 10)), undefined, { present: false, backstopping: false });
  assert.equal(nearReserve(alerts)!.severity, 'warning', 'no grid backstop ⇒ stays warning');
});

test('shp2-near-reserve stays warning when grid is omitted (safe default)', () => {
  const alerts = computeAlerts(devices(shp2(14, 10)));
  assert.equal(nearReserve(alerts)!.severity, 'warning');
});
