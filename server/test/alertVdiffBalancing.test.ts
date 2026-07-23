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

function dpuWithPack(pack: Record<string, number | null>, soc = 95): Record<string, DeviceSnapshot> {
  const projection = {
    kind: 'dpu',
    soc,
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

// soc 50 = OFF the v0.58.0 high-SoC plateau, so the 60 mV crit threshold is the
// standard 50 mV and these balancing-gate cases keep their original meaning.
test('vdiff-crit while BALANCING is still raised (visible) but annunciate:false (no chime/push)', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 60, balanceState: 1 }, 50));
  assert.ok(a, 'critical imbalance alert should still be raised so it stays on-screen');
  assert.equal(a!.severity, 'critical');
  assert.equal(a!.annunciate, false);
  assert.match(a!.detail, /balancing/i);
});

test('vdiff-crit while NOT balancing annunciates normally (a real sustained fault)', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 60, balanceState: 0 }, 50));
  assert.ok(a);
  // No annunciate key (or anything but false) → default-annunciating critical.
  assert.notEqual(a!.annunciate, false);
});

test('vdiff-warn while BALANCING is likewise gated to annunciate:false', () => {
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 2 }));
  assert.ok(a);
  assert.equal(a!.annunciate, false);
});

test('vdiff-warn while NOT balancing annunciates normally (below the quiet plateau)', () => {
  // soc 80 — under the v1.45.0 95% plateau-quiet line, so the balancing gate
  // alone decides annunciation here.
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 0 }, 80));
  assert.ok(a);
  assert.notEqual(a!.annunciate, false);
});

/* v1.45.0 — top-of-charge quiet for the WARN band. 2026-07-23 ground truth:
 * the first full grid top-up in weeks put every pack >= 95% and 14 of 15
 * packs fired 24-49 mV warn-band spreads that self-cleared in minutes. Those
 * stay VISIBLE but must not push; the critical path is untouched. */
test('v1.45.0 — warn-band spread on a >= 95% pack is visible but annunciate:false', () => {
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 0 }, 96));
  assert.ok(a, 'stays visible in the UI');
  assert.equal(a!.annunciate, false);
  assert.match(a!.detail, /top-of-charge/i);
});

test('v1.45.0 — the same spread at 94% annunciates normally (quiet line is 95)', () => {
  const a = vdiffWarn(dpuWithPack({ maxVolDiffMv: 30, balanceState: 0 }, 94));
  assert.ok(a);
  assert.notEqual(a!.annunciate, false);
});

test('v1.45.0 — a plateau-critical spread (>= 90 mV) at 96% still annunciates as critical', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 95, balanceState: 0 }, 96));
  assert.ok(a, 'a genuinely large spread is critical even at top of charge');
  assert.equal(a!.severity, 'critical');
  assert.notEqual(a!.annunciate, false);
});

test('a spread below the warn threshold raises no vdiff alert at all, even while balancing', () => {
  const devices = dpuWithPack({ maxVolDiffMv: 10, balanceState: 1 });
  assert.equal(vdiffCrit(devices), undefined);
  assert.equal(vdiffWarn(devices), undefined);
});

/* ===================================================================
 * v0.58.0 — high-SoC LFP plateau relax. Cell spread balloons transiently at the
 * top of charge with the BMS idle (balanceState=0), which the v0.29.0 balancing
 * gate does NOT catch — so 50 mV chimed an audible CRITICAL klaxon every top-of-
 * charge cycle (live: 14 red broadcasts in two bursts, resting spread 2-5 mV).
 * Above VOL_DIFF_PLATEAU_SOC_PCT (85%) the critical threshold relaxes to
 * VOL_DIFF_PLATEAU_CRIT_MV (90 mV); a benign 50-89 mV plateau excursion becomes a
 * VISIBLE, non-annunciating warning; a genuinely large spread still goes critical.
 * =================================================================== */

test('plateau (soc 95, idle): a 60 mV spread is a non-annunciating WARNING, not an audible critical', () => {
  const devices = dpuWithPack({ maxVolDiffMv: 60, balanceState: 0 }, 95);
  assert.equal(vdiffCrit(devices), undefined, '60 mV at 95% SoC must NOT promote to critical');
  const w = vdiffWarn(devices);
  assert.ok(w, 'it stays visible as a warning');
  assert.equal(w!.annunciate, false, 'benign top-of-charge spread must not chime/push');
  assert.match(w!.detail, /top-of-charge/i);
});

test('plateau (soc 95, idle): a genuinely large spread (>= 90 mV) still goes CRITICAL and annunciates', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 95, balanceState: 0 }, 95));
  assert.ok(a, 'a 95 mV spread exceeds the relaxed plateau ceiling → still critical');
  assert.equal(a!.severity, 'critical');
  assert.notEqual(a!.annunciate, false, 'a real large imbalance still chimes');
});

test('off-plateau (soc 50, idle): a 60 mV spread is unchanged — annunciating CRITICAL', () => {
  const a = vdiffCrit(dpuWithPack({ maxVolDiffMv: 60, balanceState: 0 }, 50));
  assert.ok(a, 'below the plateau SoC the standard 50 mV crit threshold applies');
  assert.equal(a!.severity, 'critical');
  assert.notEqual(a!.annunciate, false);
});
