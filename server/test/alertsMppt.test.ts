import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.9.80 — MPPT error-code alerts must only fire while the string is
 * PRODUCING. During curtailment the DPU sheds the LV string (and
 * throttles HV): the input shows open-circuit voltage but ~0 A / 0 W,
 * and EcoFlow reports a non-zero *standby* status in hvPvErrCode /
 * lvPvErrCode that is NOT a fault. The 42h production log queued
 * "HV/LV MPPT error code" 17× while the live codes read 0 — the classic
 * shed signature. The guard mirrors the UI's channelState thresholds
 * (10 V / 0.1 A).
 * =================================================================== */

function dpuWith(over: Record<string, number | null>): Record<string, DeviceSnapshot> {
  const projection = {
    kind: 'dpu',
    soc: 95,
    packs: [],
    pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
    pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
    pvHighErrCode: 0, pvLowErrCode: 0,
    acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
    batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
    splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
    chgMaxSoc: 100, dsgMinSoc: 10,
    ...over,
  };
  return {
    'DPU-1': {
      sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(), projection,
    } as unknown as DeviceSnapshot,
  };
}

const hasLvErr = (devices: Record<string, DeviceSnapshot>) =>
  computeAlerts(devices).some((a) => a.id === 'dpu-pvl-err-DPU-1');
const hasHvErr = (devices: Record<string, DeviceSnapshot>) =>
  computeAlerts(devices).some((a) => a.id === 'dpu-pvh-err-DPU-1');

test('MPPT alert SUPPRESSED on shed LV string (code set, ~0 A, voltage present)', () => {
  // The exact production false-positive: curtailment shed the LV string —
  // 130 V open-circuit, 0 A, 0 W — and EcoFlow reports a non-zero standby code.
  assert.equal(hasLvErr(dpuWith({ pvLowErrCode: 5, pvLowVolts: 130, pvLowAmps: 0, pvLowWatts: 0 })), false);
});

test('MPPT alert STILL FIRES on a real fault while producing current', () => {
  // Non-zero code while the HV string is actively drawing current = real fault.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 5, pvHighVolts: 380, pvHighAmps: 4.2, pvHighWatts: 1596 })), true);
});

test('MPPT alert SUPPRESSED when lit but producing ~0 W (idle/shed)', () => {
  // Edge: voltage present, trickle of noise current, but 0 W → idle, not fault.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 5, pvHighVolts: 130, pvHighAmps: 0.05, pvHighWatts: 0 })), false);
});

test('MPPT alert SUPPRESSED on sunset shutdown trickle (0 W, 0.275 A above old amp floor)', () => {
  // The exact live false-positive that slipped through the v0.9.80 amp floor:
  // Core 2 HV at sunset — 0 W, 164 V, 0.275 A (> 0.1 A), code 457. All cores
  // reported identical 457/177 codes simultaneously = benign standby, not a
  // fault. The watt floor (v0.9.81) catches it: 0 W → not producing.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 457, pvHighVolts: 164, pvHighAmps: 0.275, pvHighWatts: 0 })), false);
});

test('MPPT alert SUPPRESSED on the dusk ramp-down (55 W reported but 0.0 A) — v1.0.1', () => {
  // The live false-positive that slipped through the v0.9.81 WATT floor. Captured from the
  // running system: Core 3 HV, code 457, 294 V, 0.0 A, 55 W — the alert text itself read
  // "producing 55 W (294 V, 0.0 A)", i.e. EcoFlow's watt and amp fields disagree during the
  // ramp-down. All three home Cores reported the identical 457 at that instant, and a real
  // fault cannot be identical across independent units. Requiring BOTH watts and current
  // rejects it; 55 W passes the watt floor but 0.0 A fails the amp floor.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 457, pvHighVolts: 294, pvHighAmps: 0, pvHighWatts: 55 })), false);
});

test('MPPT alert STILL FIRES when watts AND current are both real (regression guard)', () => {
  // The amp requirement must not mask a genuine producing-fault: 1.5 A is well clear of the
  // 0.3 A shutdown-trickle floor.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 457, pvHighVolts: 300, pvHighAmps: 1.5, pvHighWatts: 450 })), true);
});

test('MPPT alert falls back to the watt test when the device reports no current', () => {
  // amps == null (no current telemetry) must NOT silently suppress a real code.
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 5, pvHighVolts: 380, pvHighAmps: null, pvHighWatts: 1596 })), true);
});

test('MPPT alert not raised at all when code is zero (baseline)', () => {
  assert.equal(hasHvErr(dpuWith({ pvHighErrCode: 0, pvHighVolts: 380, pvHighAmps: 4.2 })), false);
  assert.equal(hasLvErr(dpuWith({ pvLowErrCode: 0, pvLowVolts: 130, pvLowAmps: 0 })), false);
});
