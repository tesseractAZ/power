import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.29.0 — a vdiff (cell-imbalance) alert that fires WHILE the BMS is
 * actively balancing must stay VISIBLE but never annunciate (chime/push).
 * The static 50 mV crit threshold is INSTANTANEOUS, gets 0 ms debounce, and
 * is EXEMPT from auto-silencing — so balancing-driven cell-spread transients
 * were storming the CRITICAL chime (live: 67 rises in 7 days, 69% cleared
 * < 10 min, 3-min median — the classic balancing signature). Gate annunciation
 * while balancing; a genuine sustained imbalance persists past balancing and
 * re-fires annunciating.
 * =================================================================== */

function dpuWithPack(pack: Record<string, number | null>): Record<string, DeviceSnapshot> {
  const projection = {
    kind: 'dpu',
    soc: 95,
    packs: [{ num: 1, ...pack }],
    pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
    pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
    pvHighErrCode: 0, pvLowErrCode: 0,
    acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
    batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
    chgMaxSoc: 100, dsgMinSoc: 10,
  };
  return {
    'DPU-1': {
      sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(), projection,
    } as unknown as DeviceSnapshot,
  };
}

const vdiffCrit = (devices: Record<string, DeviceSnapshot>) =>
  computeAlerts(devices).find((a) => a.id === 'vdiff-crit-DPU-1-1');
const vdiffWarn = (devices: Record<string, DeviceSnapshot>) =>
  computeAlerts(devices).find((a) => a.id === 'vdiff-warn-DPU-1-1');

test('vdiff-crit while BALANCING is still raised (visible) but annunciate:false (no chime/push)', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 60, balanceState: 1 }));
  assert.ok(a, 'critical imbalance alert should still be raised so it stays on-screen');
  assert.equal(a!.severity, 'critical');
  assert.equal(a!.annunciate, false);
  assert.match(a!.detail, /balancing/i);
});

test('vdiff-crit while NOT balancing annunciates normally (a real sustained fault)', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 60, balanceState: 0 }));
  assert.ok(a);
  // No annunciate key (or anything but false) → default-annunciating critical.
  assert.notEqual(a!.annunciate, false);
});

test('vdiff-warn while BALANCING is likewise gated to annunciate:false', () => {
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 2 }));
  assert.ok(a);
  assert.equal(a!.annunciate, false);
});

test('vdiff-warn while NOT balancing annunciates normally', () => {
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 0 }));
  assert.ok(a);
  assert.notEqual(a!.annunciate, false);
});

test('a spread below the warn threshold raises no vdiff alert at all, even while balancing', () => {
  const devices = dpuWithPack({ maxVolDiffMv: 10, balanceState: 1 });
  assert.equal(vdiffCrit(devices), undefined);
  assert.equal(vdiffWarn(devices), undefined);
});
