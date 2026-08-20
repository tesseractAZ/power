import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertSourceSn, isEvidenceExemptFamily, deviceEvidenceFresh, fallingEdgeFrozenByEvidence,
  orphanedNotifiedIds, DEVICE_EVIDENCE_STALE_MS, resolveHandoffOwner,
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

/* ─── v1.77.0 — a /status-offline device is not positive evidence ─────────── */

test('THE 04:17 BLIP: fresh-but-offline device FREEZES its fault alert falling edge', () => {
  // The SHP2 dropped off /status for 7 seconds while REST kept lastUpdated fresh.
  // Freshness alone waved the resolve through; online:false must freeze it.
  const frozen = fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 10_000, online: false } }, nowMs: NOW,
  });
  assert.equal(frozen, true, 'a false "Resolved:" at 4 AM must be impossible');
});

test('online:true with fresh data resolves normally; missing flag stays neutral', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 10_000, online: true } }, nowMs: NOW,
  }), false);
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: { [SN]: { lastUpdated: NOW - 10_000 } }, nowMs: NOW,
  }), false, 'no online flag = neutral, freshness decides');
});

/* ─── v1.78.0 — explicit sourceSn closes the SN-less-id hole ──────────────── */

const SHP2SN = 'HD31ZASAHH120432';

test('THE MOTIVATING CASE: shp2-src-err-3 with sourceSn freezes on an offline-but-fresh SHP2', () => {
  // v1.77.0 shipped to close the 04:17 false "Resolved: Energy source error"
  // and MISSED it: the id carries no serial, alertSourceSn returned null, and
  // the gate exited before the evidence check. The explicit declaration wins.
  assert.equal(fallingEdgeFrozenByEvidence({
    id: 'shp2-src-err-3', deviceSns: [...ROSTER, SHP2SN], sourceSn: SHP2SN,
    devices: { [SHP2SN]: { lastUpdated: NOW - 5_000, online: false } }, nowMs: NOW,
  }), true, 'a 7-second /status blip must freeze the falling edge, not resolve a standing critical');
});

test('sourceSn: stale device freezes; fresh+online device resolves normally', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: 'backup-soc-20', deviceSns: [SHP2SN], sourceSn: SHP2SN,
    devices: { [SHP2SN]: { lastUpdated: NOW - 3_600_000, online: true } }, nowMs: NOW,
  }), true, 'stale telemetry is blindness, not recovery');
  assert.equal(fallingEdgeFrozenByEvidence({
    id: 'shp2-src-err-3', deviceSns: [SHP2SN], sourceSn: SHP2SN,
    devices: { [SHP2SN]: { lastUpdated: NOW - 5_000, online: true } }, nowMs: NOW,
  }), false, 'fresh, online source = a genuine clear may resolve');
});

test('sourceSn on an evidence-EXEMPT family still never freezes', () => {
  // offline-* exists to fall when the device is absent; an explicit sourceSn
  // must not re-arm the gate for it.
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `offline-${SHP2SN}`, deviceSns: [SHP2SN], sourceSn: SHP2SN,
    devices: {}, nowMs: NOW,
  }), false);
});

test('no sourceSn: the id search still protects SN-bearing ids (v1.75.0 contract intact)', () => {
  assert.equal(fallingEdgeFrozenByEvidence({
    id: `dpu-err-${SN}`, deviceSns: [...ROSTER],
    devices: {}, nowMs: NOW,
  }), true);
});

/* ─── v1.78.0 — ownership handoff: no resolve push on a worsening transition ── */

test('backup-soc vanishing INTO an active shp2 pair alert is a handoff, not a recovery', () => {
  assert.equal(resolveHandoffOwner('backup-soc-20', new Set(['shp2-near-reserve'])), 'shp2-near-reserve');
  assert.equal(resolveHandoffOwner('backup-soc-20', new Set(['shp2-below-reserve'])), 'shp2-below-reserve');
  // below outranks near when both are somehow present
  assert.equal(resolveHandoffOwner('backup-soc-10', new Set(['shp2-below-reserve', 'shp2-near-reserve'])), 'shp2-below-reserve');
});

test('a GENUINE band recovery (successor absent) is not a handoff — the resolve still goes', () => {
  assert.equal(resolveHandoffOwner('backup-soc-20', new Set(['soc-low-X'])), null);
  assert.equal(resolveHandoffOwner('backup-soc-20', new Set()), null);
});

test('handoff detection is scoped to the band family only', () => {
  assert.equal(resolveHandoffOwner('soc-low-A-1', new Set(['shp2-near-reserve'])), null);
  assert.equal(resolveHandoffOwner(`dpu-err-${SN}`, new Set(['shp2-below-reserve'])), null);
});

/* ═══ v1.88.0 — settle-family push debounce + auto-tuned resolve suppression ═ */

import { pushDebounceMsFor, SETTLE_PUSH_DEBOUNCE_MS, shouldSendResolve } from '../src/alertMonitor.js';

test('settle families hold their PUSH 5 minutes; everything else keeps the default', () => {
  for (const id of ['vdiff-crit-SN-1', 'peer-voldiff-SN-2', 'peer-soc-SN-1', 'soc-low-SN-3', 'dpu-imbalance-SN']) {
    assert.equal(pushDebounceMsFor(id, 60_000), SETTLE_PUSH_DEBOUNCE_MS, id);
  }
  assert.equal(pushDebounceMsFor('dpu-err-SN', 60_000), 60_000, 'a battery-protection fault is not settling noise');
  assert.equal(pushDebounceMsFor('backup-soc-20', 60_000), 60_000);
  assert.equal(pushDebounceMsFor('shp2-src-err-3', 60_000), 60_000);
  // the default never SHRINKS a larger configured debounce
  assert.equal(pushDebounceMsFor('vdiff-crit-SN-1', 10 * 60_000), 10 * 60_000);
});

test('a fire the operator saw as auto-tuned "[Low]" owes no "Resolved:" push', () => {
  const base = { pushSent: true, notifiedSeverity: 'warning' as const, alert: { id: 'peer-soc-SN-1', severity: 'warning' as const } };
  // delivered at source tier → resolve owed
  assert.equal(shouldSendResolve({ ...base, notifiedEffectiveSeverity: 'warning' }, true, 'warning'), true);
  // auto-tuned down to info at delivery → the resolve of a demoted event is noise
  assert.equal(shouldSendResolve({ ...base, notifiedEffectiveSeverity: 'info' }, true, 'warning'), false);
  // legacy entries without the field keep the old behavior (notifiedSeverity decides)
  assert.equal(shouldSendResolve(base, true, 'warning'), true);
});
