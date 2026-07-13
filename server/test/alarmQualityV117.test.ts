import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, resetOnScreenSocBandForTesting, type Alert } from '../src/alerts.js';
import { activeSocBandWithHysteresis } from '../src/batterySocAlarm.js';
import { isForecastDipResolveDwellFamily } from '../src/alertMonitor.js';
import { computeLearnedAlerts, _resetPeerHitCounts } from '../src/analytics.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.17.0 — engine-review alarm-quality batch (F13/F14/F15/F18).
 *
 * F14: the reserve-floor classifier used strict `<` while runwayAlarm
 *      uses `<=` — a pool pinned at EXACTLY the integer reserve for
 *      hours (the common nightly steady state) read "approaching
 *      reserve" (warning off-grid) instead of at/below (critical).
 * F15: the on-screen backup-soc band had zero hysteresis — SoC
 *      chattering on a boundary toggled bands every sample (399 rises
 *      in 30 days vs ~115 hysteresis-qualified real crossings).
 * F18: the peer-temp effect-size floor (5°F) sat below benign sibling
 *      spread — 1407 rises/30d, 0 of 400 sampled actionable; raised to
 *      9°F (5°C), just above the observed benign envelope (max 4.5°C).
 * F13: forecast-soc-dip re-rose 185×/40d on forecast-pipeline flicker;
 *      it joins the resolve-side dwell + gains an hours-below-reserve
 *      discriminating fact (tested in forecast.test.ts).
 * =================================================================== */

const now = Date.now();

function shp2(backupBatPercent: number | null, backupReserveSoc = 10): DeviceSnapshot {
  return {
    sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now,
    projection: { kind: 'shp2', backupBatPercent, backupReserveSoc, sources: [], pairedCircuits: [] } as any,
  } as DeviceSnapshot;
}
const devices = (...arr: DeviceSnapshot[]): Record<string, DeviceSnapshot> =>
  Object.fromEntries(arr.map((d) => [d.sn, d]));

const belowReserve = (a: Alert[]) => a.find((x) => x.id === 'shp2-below-reserve');
const nearReserve = (a: Alert[]) => a.find((x) => x.id === 'shp2-near-reserve');
const backupSocIds = (a: Alert[]) => a.filter((x) => x.id.startsWith('backup-soc-')).map((x) => x.id);

/* ── F14: inclusive reserve-floor comparison ──────────────────────── */

test('F14 — pool pinned at EXACTLY the reserve floor classifies at/below, not "approaching"', () => {
  resetOnScreenSocBandForTesting();
  // Off-grid (grid omitted ⇒ safe default): exactly-at-floor must be the
  // critical at/below alert — this is the overnight-outage steady state.
  const alerts = computeAlerts(devices(shp2(10, 10)));
  const below = belowReserve(alerts);
  assert.ok(below, 'exactly-at-reserve must emit shp2-below-reserve');
  assert.equal(below?.severity, 'critical', 'off-grid at-the-floor is critical (runwayAlarm parity)');
  assert.equal(nearReserve(alerts), undefined, 'shp2-near-reserve must NOT double-fire');
});

test('F14 — exactly-at-reserve while grid-backstopped stays a quiet info advisory', () => {
  resetOnScreenSocBandForTesting();
  const alerts = computeAlerts(devices(shp2(10, 10)), undefined, { backstopping: true, reason: 'grid present' });
  const below = belowReserve(alerts);
  assert.ok(below);
  assert.equal(below?.severity, 'info', 'on-grid at-the-floor is info — nightly floor-riding must not page');
});

test('F14 — one point above reserve is still "approaching" (warning off-grid)', () => {
  resetOnScreenSocBandForTesting();
  const alerts = computeAlerts(devices(shp2(11, 10)));
  assert.equal(belowReserve(alerts), undefined);
  const near = nearReserve(alerts);
  assert.ok(near, 'reserve+1 emits shp2-near-reserve');
  assert.equal(near?.severity, 'warning');
});

/* ── F15: on-screen band hysteresis ───────────────────────────────── */

test('F15 — activeSocBandWithHysteresis holds the band through boundary chatter', () => {
  // Descending crossing establishes the 40 band.
  assert.equal(activeSocBandWithHysteresis(39, null)?.pct, 40);
  // Chatter back up to 41/42: raw banding says 50, hysteresis holds 40
  // until SoC clears 40 + 2.
  assert.equal(activeSocBandWithHysteresis(41, 40)?.pct, 40, '41 with held 40 stays 40');
  assert.equal(activeSocBandWithHysteresis(42, 40)?.pct, 40, 'boundary 42 (=40+2) still holds');
  assert.equal(activeSocBandWithHysteresis(42.1, 40)?.pct, 50, 'above the margin ascends to raw banding');
});

test('F15 — a deeper crossing escalates immediately (hysteresis never delays a worse state)', () => {
  assert.equal(activeSocBandWithHysteresis(29, 40)?.pct, 30);
  assert.equal(activeSocBandWithHysteresis(7, 40)?.pct, 8);
});

test('F15 — null/non-finite SoC drops the band; top-of-ladder clears past the margin', () => {
  assert.equal(activeSocBandWithHysteresis(null, 40), null, 'null SoC never fabricates a hold');
  assert.equal(activeSocBandWithHysteresis(NaN, 40), null);
  assert.equal(activeSocBandWithHysteresis(51, 50)?.pct, 50, '51 holds the top band');
  assert.equal(activeSocBandWithHysteresis(53, 50), null, '53 (>50+2) clears entirely');
});

test('F15 — computeAlerts integration: 39↔41 chatter keeps ONE stable backup-soc-40 alert', () => {
  resetOnScreenSocBandForTesting();
  // Pre-fix, this sequence toggled backup-soc-40 ↔ backup-soc-50 on every
  // sample (the telemetry showed backup-soc-30/40 flipping 7× in 16 min).
  const seq = [39, 41, 39, 41, 42, 39];
  for (const soc of seq) {
    const ids = backupSocIds(computeAlerts(devices(shp2(soc, 10))));
    assert.deepEqual(ids, ['backup-soc-40'], `soc=${soc}: expected the held 40 band, got ${ids}`);
  }
  // Genuine recovery past the margin ascends to the 50 band…
  assert.deepEqual(backupSocIds(computeAlerts(devices(shp2(45, 10)))), ['backup-soc-50']);
  // …and clearing past 50+2 removes the alert entirely.
  assert.deepEqual(backupSocIds(computeAlerts(devices(shp2(53, 10)))), []);
});

test('F15 — held-above detail says "near", not the false "at or below"', () => {
  resetOnScreenSocBandForTesting();
  computeAlerts(devices(shp2(39, 10))); // establish the 40 band
  const alerts = computeAlerts(devices(shp2(41, 10)));
  const a = alerts.find((x) => x.id === 'backup-soc-40');
  assert.ok(a);
  assert.ok(!/at or below/.test(a!.detail), 'a 41% reading must not claim "at or below" 40%');
  assert.ok(/holding the 40% band/.test(a!.detail), 'held state is explained');
});

/* ── F18: peer-temp effect-size floor ─────────────────────────────── */

/** One online DPU, packs identical except one pack's cell temp offset by
 *  `deltaC` — identical siblings ⇒ MAD 0, exercising the floor directly. */
function dpuWithTempOutlier(deltaC: number, sn = 'SN-DPU-T'): Record<string, DeviceSnapshot> {
  const base = { soc: 80, soh: 100, actSoh: 100, maxVolDiffMv: 20, inputWatts: 0, outputWatts: 0, cycles: 50, minCellTemp: 30 };
  const packs = [
    { num: 1, temp: 30, maxCellTemp: 30, ...base },
    { num: 2, temp: 30, maxCellTemp: 30, ...base },
    { num: 3, temp: 30, maxCellTemp: 30, ...base },
    { num: 4, temp: 30, maxCellTemp: 30, ...base },
    { num: 5, temp: 30 + deltaC, maxCellTemp: 30 + deltaC, ...base },
  ];
  return {
    [sn]: {
      sn, deviceName: 'Core 1', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs } as any,
    } as any,
  };
}

const peerTempAlerts = (alerts: ReturnType<typeof computeLearnedAlerts>) =>
  alerts.filter((a) => a.id.startsWith('peer-temp-'));

test('F18 — the entire observed benign envelope (≤4.5°C sibling delta) no longer fires peer-temp', () => {
  _resetPeerHitCounts();
  // 4.5°C = 8.1°F: the MAXIMUM delta seen across 400 ground-truth-joined rises
  // from the 1407-rise month — every one of them benign. Below the new 9°F floor.
  for (let i = 0; i < 4; i++) {
    const alerts = computeLearnedAlerts(dpuWithTempOutlier(4.5));
    assert.equal(peerTempAlerts(alerts).length, 0, `4.5°C sibling delta must stay silent (cycle ${i + 1})`);
  }
});

test('F18 — a thermally meaningful outlier (5.5°C ≈ 9.9°F) still fires after the hit gate', () => {
  _resetPeerHitCounts();
  const devs = dpuWithTempOutlier(5.5);
  computeLearnedAlerts(devs); // cycle 1 — hysteresis gate
  computeLearnedAlerts(devs); // cycle 2
  const alerts = computeLearnedAlerts(devs); // cycle 3 — emits
  assert.equal(peerTempAlerts(alerts).length, 1, 'a genuine ≥9°F outlier must still alert');
});

/* ── F13: forecast-soc-dip resolve dwell family ───────────────────── */

test('F13 — isForecastDipResolveDwellFamily matches exactly the forecast-soc-dip id', () => {
  assert.equal(isForecastDipResolveDwellFamily({ id: 'forecast-soc-dip' }), true);
  assert.equal(isForecastDipResolveDwellFamily({ id: 'forecast-low-solar' }), false);
  assert.equal(isForecastDipResolveDwellFamily({ id: 'forecast-runtime' }), false);
  assert.equal(isForecastDipResolveDwellFamily({ id: 'soc-low-SN-1' }), false);
  assert.equal(isForecastDipResolveDwellFamily({ id: 'shp2-below-reserve' }), false);
});
