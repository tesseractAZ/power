import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, resetVdiffWarnHoldForTesting } from '../src/alerts.js';
import { isCellImbalanceResolveDwellFamily } from '../src/alertMonitor.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.21.0 — engine-review F28: cell-imbalance churn at the 20 mV line.
 *
 * 1. `vdiff-warn` had ZERO rise-side hysteresis at VOL_DIFF_WARN_MV=20:
 *    threshold-kissing 19-22 mV spreads fired on every touch (30-day ground
 *    truth: 73-100% of rises cleared within minutes). The v0.77 resolve dwell
 *    only holds the RESOLVE push — it cannot stop the re-fire on the next
 *    kiss. Now: FIRE at >= 24 mV, HOLD while still >= 20 mV, clear below 20.
 * 2. `peer-voldiff` joins the cell-imbalance resolve-dwell family: 100% of
 *    its rises short-cleared DESPITE the v0.13.2 3-consecutive-cycle rise
 *    gate (the outlier persists the ~60 s needed to emit, then drops back
 *    minutes later — only holding the resolve absorbs that).
 * =================================================================== */

function dpuWithPack(pack: Record<string, number | null>, soc = 50): Record<string, DeviceSnapshot> {
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

const warnAt = (mv: number | null) =>
  computeAlerts(dpuWithPack({ maxVolDiffMv: mv, balanceState: 0 })).find(
    (a) => a.id === 'vdiff-warn-DPU-1-1',
  );
const critAt = (mv: number) =>
  computeAlerts(dpuWithPack({ maxVolDiffMv: mv, balanceState: 0 })).find(
    (a) => a.id === 'vdiff-crit-DPU-1-1',
  );

beforeEach(() => resetVdiffWarnHoldForTesting());

test('F28 — a threshold-kissing spread (20-23 mV) no longer fires vdiff-warn', () => {
  for (const mv of [20, 21, 22, 23]) {
    assert.equal(warnAt(mv), undefined, `${mv} mV must not fire (rise floor is 24)`);
    resetVdiffWarnHoldForTesting();
  }
});

test('F28 — 24 mV fires, then the warning HOLDS through the 20-23 mV band and clears below 20', () => {
  assert.ok(warnAt(24), 'rise at 24 mV fires');
  assert.ok(warnAt(21), 'held: 21 mV keeps the warning while the episode is live');
  assert.match(warnAt(20)!.detail, /fires ≥ 24 mV, holds ≥ 20 mV/, 'held at exactly 20; detail states both lines');
  assert.equal(warnAt(19), undefined, 'below 20 clears');
  assert.equal(warnAt(21), undefined, 'after clearing, 21 mV must RE-EARN the 24 mV rise');
  assert.ok(warnAt(24), 'and 24 mV re-fires a new episode');
});

test('F28 — a spread descending OUT of critical keeps its warning through the 20-49 mV band', () => {
  assert.ok(critAt(60), '60 mV is critical off-plateau');
  assert.equal(warnAt(60), undefined, 'no simultaneous warn while critical');
  const w = warnAt(30);
  assert.ok(w, 'descending 60 → 30 mV emits the warning (the crit episode marked the hold)');
  assert.ok(warnAt(21), 'still held at 21');
  assert.equal(warnAt(19), undefined, 'clears below 20');
});

test('F28 — a data gap (vdiff null) resets the episode: data returning in the kiss band does not re-fire', () => {
  assert.ok(warnAt(24));
  assert.equal(warnAt(null), undefined, 'null reading emits nothing');
  assert.equal(warnAt(22), undefined, 'post-gap 22 mV is a NEW episode below the rise floor');
});

test('F28 — a device absent for a cycle resets the episode (held keys are pruned)', () => {
  assert.ok(warnAt(24));
  computeAlerts({}); // the device disappears entirely for one cycle
  assert.equal(warnAt(22), undefined, 'the returning device must re-earn the rise');
});

test('F28 — hysteresis state is per-pack: pack 2 kissing does not inherit pack 1 hold', () => {
  // Fire pack 1 at 24, then present BOTH packs with pack 2 kissing at 22.
  assert.ok(warnAt(24));
  const devices = dpuWithPack({ maxVolDiffMv: 21, balanceState: 0 });
  (devices['DPU-1'].projection as any).packs.push({
    ...(devices['DPU-1'].projection as any).packs[0], num: 2, maxVolDiffMv: 22,
  });
  const alerts = computeAlerts(devices);
  assert.ok(alerts.find((a) => a.id === 'vdiff-warn-DPU-1-1'), 'pack 1 still held at 21');
  assert.equal(alerts.find((a) => a.id === 'vdiff-warn-DPU-1-2'), undefined, 'pack 2 at 22 never fired');
});

test('F28 — annunciation gates compose with the hold: a held warning while balancing stays annunciate:false', () => {
  assert.ok(warnAt(30), 'fire the episode');
  const held = computeAlerts(dpuWithPack({ maxVolDiffMv: 21, balanceState: 1 })).find(
    (a) => a.id === 'vdiff-warn-DPU-1-1',
  );
  assert.ok(held, 'held through the kiss band');
  assert.equal(held!.annunciate, false, 'balancing gate still silences the held alert');
});

test('F28 — a hold must not leak across the SN boundary (same pack number on two devices)', () => {
  // Mutation-testing survivor: keying the hold by pack number alone would let a
  // real >=24 mV episode on one Core grant every same-numbered pack fleet-wide
  // a 20 mV kiss-fire pass. Cycle shape matters: each cycle presents ONLY one
  // device, so under the mutant the collided key "1" survives the prune via the
  // other device's presence and wrongly fires.
  const only = (sn: string, mv: number) => {
    const devices = dpuWithPack({ maxVolDiffMv: mv, balanceState: 0 });
    const d = devices['DPU-1'];
    delete devices['DPU-1'];
    (d as any).sn = sn;
    devices[sn] = d;
    return computeAlerts(devices);
  };
  assert.ok(only('DPU-A', 24).find((a) => a.id === 'vdiff-warn-DPU-A-1'), 'DPU-A pack 1 fires at 24');
  assert.equal(
    only('DPU-B', 22).find((a) => a.id === 'vdiff-warn-DPU-B-1'),
    undefined,
    "DPU-B pack 1 at 22 mV must not inherit DPU-A's hold",
  );
  assert.equal(
    only('DPU-A', 22).find((a) => a.id === 'vdiff-warn-DPU-A-1'),
    undefined,
    "DPU-A's own hold was pruned while it was absent — 22 mV must re-earn the rise",
  );
});

/* ── peer-voldiff joins the resolve-dwell family ─────────────────── */

test('F28 — isCellImbalanceResolveDwellFamily now matches peer-voldiff per-pack ids', () => {
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'peer-voldiff-Y711FAB59J234000-3' }), true);
  // The pre-existing members are unchanged.
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'vdiff-warn-DPU-1-1' }), true);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'vdiff-crit-DPU-1-1' }), true);
});

test('F28 — the other peer families do NOT get the dwell (temp fixed at the floor in v1.17, soc in v0.13.2)', () => {
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'peer-temp-DPU-1-1' }), false);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'peer-soc-DPU-1-1' }), false);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'peer-soh-DPU-1-1' }), false);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'peer-voldiffx-DPU-1-1' }), false);
});
