import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertSourceSn, isEvidenceExemptFamily, deviceEvidenceFresh, fallingEdgeFrozenByEvidence,
  orphanedNotifiedIds, DEVICE_EVIDENCE_STALE_MS,
} from '../src/alertMonitor.js';

/**
 * v1.75.0 — the 2026-08-08 13:11-13:22 flap storm. A cloud presence flap made the
 * standing Core 3 err533 CRITICAL emit false "Resolved:" pushes (12 pushes of
 * churn). Resolution now requires POSITIVE evidence: the source device present
 * with fresh telemetry. Absence of data is absence of data.
 */

const SN = 'Y711FAB59J234000';
const ROSTER = [SN, 'Y711ZAB59GBC0314', 'Y711ZAB59GBC0482'] as const;
const NOW = 1_786_000_000_000;

test('alertSourceSn: ids carry their subject SN; system alerts carry none', () => {
  assert.equal(alertSourceSn(`dpu-err-${SN}`, ROSTER), SN);
  assert.equal(alertSourceSn(`vdiff-crit-${SN}-1`, ROSTER), SN);
  assert.equal(alertSourceSn(`soc-low-Y711ZAB59GBC0314-4`, ROSTER), 'Y711ZAB59GBC0314');
  assert.equal(alertSourceSn('telemetry-blind', ROSTER), null);
  assert.equal(alertSourceSn('peak-grid-draw', ROSTER), null);
  assert.equal(alertSourceSn('shp2-near-reserve', ROSTER), null);
  // The length guard: a degenerate short roster key (corrupt store, test double)
  // must never substring-bind unrelated alerts to some device's freshness.
  assert.equal(alertSourceSn('dpu-err-XYZ', ['r', 'err', 'dpu']), null);
});

test('exempt families: absence-subject alerts are never evidence-gated', () => {
  assert.equal(isEvidenceExemptFamily(`offline-${SN}`), true);
  assert.equal(isEvidenceExemptFamily(`offline-spare-${SN}`), true);
  assert.equal(isEvidenceExemptFamily(`msg-rate-floor-${SN}`), true);
  assert.equal(isEvidenceExemptFamily(`zombie-${SN}`), true);
  assert.equal(isEvidenceExemptFamily(`dpu-err-${SN}`), false);
});

test('deviceEvidenceFresh: fresh passes, stale/absent/never-updated fail', () => {
  assert.equal(deviceEvidenceFresh({ lastUpdated: NOW - 30_000 }, NOW), true);
  assert.equal(deviceEvidenceFresh({ lastUpdated: NOW - DEVICE_EVIDENCE_STALE_MS - 1 }, NOW), false);
  assert.equal(deviceEvidenceFresh(undefined, NOW), false, 'device gone from the map');
  assert.equal(deviceEvidenceFresh({}, NOW), false, 'no lastUpdated at all');
});

test('THE INCIDENT: a stale device FREEZES its fault alert falling edge', () => {
  const frozen = fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 10 * 60_000 } }, nowMs: NOW,
  });
  assert.equal(frozen, true, 'err533 must NOT resolve on a flap');
});

test('a device that vanished entirely also freezes the edge', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `vdiff-crit-${SN}-1`, deviceSns: [...ROSTER], devices: {}, nowMs: NOW,
  }), true);
});

test('fresh evidence UNFREEZES — genuine recoveries still resolve', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 5_000 } }, nowMs: NOW,
  }), false);
});

test('system alerts (no source SN) are never frozen', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: 'telemetry-blind', deviceSns: [...ROSTER], devices: {}, nowMs: NOW,
  }), false, 'telemetry-blind must be able to resolve while devices are absent — that IS its recovery');
});

test('exempt families are never frozen even when their device is stale', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `msg-rate-floor-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 10 * 60_000 } }, nowMs: NOW,
  }), false, 'the starvation alert clears on measured rate recovery, not projection freshness');
});

test('orphan sweep: a msg-rate-floor orphan is DROPPED, never boot-"Resolved:"', () => {
  const persisted = new Map([
    [`msg-rate-floor-${SN}`, { ts: NOW, sent: true, sev: 'warning' as const, title: 'Device barely reporting' }],
    [`soc-low-${SN}-1`, { ts: NOW, sent: true, sev: 'warning' as const, title: 'Pack nearly empty' }],
  ]);
  const { resolve, drop } = orphanedNotifiedIds({
    persisted, currentIds: new Set(), trackedIds: new Set(),
    notifyResolved: true, minSeverity: 'info',
  });
  assert.ok(drop.includes(`msg-rate-floor-${SN}`), 'rates are unknowable at boot — no positive evidence to resolve on');
  assert.ok(!resolve.includes(`msg-rate-floor-${SN}`));
  assert.ok(resolve.includes(`soc-low-${SN}-1`), 'ordinary owed resolves are unchanged');
});
