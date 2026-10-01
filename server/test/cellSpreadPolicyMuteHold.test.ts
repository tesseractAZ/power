/**
 * v1.187.1 — a POLICY mute over a knee-muted critical holds nothing.
 *
 * soundedCriticalHeld (broadcast.ts) holds the committed red while a critical that sounded is
 * present with `mutedBy` set — a bounded cell-spread mute that ends with the condition. The two
 * policy stamps that take precedence over it — the bench-spare stamp in computeAlerts and the
 * monitor's roster stamp (applyRosterMute: bench spares and off-panel Cores) — overwrote
 * `annunciate` and `muteReason` but left `mutedBy` set, so a sounded vdiff-crit muted by policy
 * that also carried a knee mute held the level red and delayed the all-clear while the knee mute
 * lasted, against "a policy mute holds nothing". The stamps now clear `mutedBy` (it names the mute
 * in force); `muteReason` stays diagnostic only (muteReasonLog.test.ts). The peer outlier's yield
 * (quietPeerSpreadUnderHeldCritical, which reads `mutedBy` too) follows the same precedence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-policy-mute-hold-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_ONSET_PATH = join(tmp, 'alert-onset.json');

const { computeAlerts, resetVdiffWarnHoldForTesting, MUTE_REASON_BALANCING, MUTE_REASON_BENCH_SPARE, MUTE_REASON_OFF_PANEL } = await import('../src/alerts.js');
const { applyRosterMute, quietPeerSpreadUnderHeldCritical } = await import('../src/alertMonitor.js');
const { soundedCriticalHeld } = await import('../src/broadcast.js');
const { alertFingerprint } = await import('../src/redReplayGate.js');
const { SPARE_DPU_SNS } = await import('../src/shp2Membership.js');

const SPARE = [...SPARE_DPU_SNS][0] as string; // read from the literal, never written out
const HOME = 'COREXXX00XXX0001';
const OFF = 'COREXXX00XXX0003';
const T = 50_000_000;

function dpu(sn: string, name: string): DeviceSnapshot {
  // A pack at 93% the BMS is balancing at 95 mV: vdiffCritMute's balancing mute holds it.
  const pack = { num: 1, soc: 93, packSn: 'PACK-A', maxVolDiffMv: 95, balanceState: 1, inputWatts: 0, outputWatts: 0, cellVoltagesMv: [] };
  return {
    sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 93, packs: [pack],
      pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0, pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
      pvHighErrCode: 0, pvLowErrCode: 0, acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
      batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
      sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000, chgMaxSoc: 100, dsgMinSoc: 10,
    },
  } as unknown as DeviceSnapshot;
}
/** The pack's vdiff-crit as computeAlerts emits it this tick. */
function critOf(sn: string, name: string): Alert {
  resetVdiffWarnHoldForTesting();
  const a = computeAlerts({ [sn]: dpu(sn, name) }).find((x) => x.id === `vdiff-crit-${sn}-1`);
  assert.ok(a, `${sn}: a cell-imbalance critical`);
  return a;
}
/** soundedCriticalHeld for one present critical that sounded at an earlier committed red. */
const holds = (a: Alert): boolean => soundedCriticalHeld([a], new Map([[alertFingerprint(a), T - 60_000]]), T);
const peerOf = (sn: string): Alert => ({
  id: `peer-voldiff-${sn}-1`, severity: 'warning', category: 'Battery', device: 'Core', title: 'Cell spread outlier', detail: 'x',
});

test('★★★ soundedCriticalHeld: a sounded critical under the BENCH-SPARE stamp holds nothing, though the knee mute also applies', () => {
  const home = critOf(HOME, 'Core 1');
  assert.equal(home.annunciate, false);
  assert.equal(home.mutedBy, 'balancing', 'a home Core: the bounded mute is in force');
  assert.equal(holds(home), true, 'held, not cleared (v1.187.0)');

  const spare = critOf(SPARE, 'Core 9');
  assert.equal(spare.annunciate, false);
  assert.equal(spare.muteReason, MUTE_REASON_BENCH_SPARE);
  assert.equal(holds(spare), false, 'a policy mute holds nothing: the all-clear is not delayed');
  assert.equal(spare.mutedBy, undefined, 'the spare stamp takes precedence: no bounded mute is in force');
});

test('★★★ soundedCriticalHeld: a sounded critical under the monitor\'s ROSTER stamp holds nothing, though the knee mute also applies', () => {
  // As alerts.ts emits a home Core's knee-muted critical, before the monitor's roster pass.
  const off = critOf(OFF, 'Core 3');
  assert.equal(off.mutedBy, 'balancing');
  assert.equal(off.muteReason, MUTE_REASON_BALANCING);
  applyRosterMute(off, [OFF], []);
  assert.equal(off.annunciate, false);
  assert.equal(off.muteReason, MUTE_REASON_OFF_PANEL);
  assert.equal(holds(off), false, 'an off-panel Core\'s critical holds nothing');
  assert.equal(off.mutedBy, undefined, 'the roster takes precedence');

  const spare = critOf(HOME, 'Core 1');
  applyRosterMute(spare, [HOME], [HOME]); // listed as a bench spare by the monitor's roster
  assert.equal(spare.muteReason, MUTE_REASON_BENCH_SPARE);
  assert.equal(holds(spare), false);

  // Not on the roster: the knee mute is still the one in force, and it holds.
  const home = critOf(HOME, 'Core 1');
  applyRosterMute(home, [OFF], []);
  assert.equal(home.mutedBy, 'balancing');
  assert.equal(holds(home), true);
});

test('★★ the peer outlier\'s yield follows the same precedence: a bench spare\'s policy-muted critical quiets nothing', () => {
  const spareSet = quietPeerSpreadUnderHeldCritical([critOf(SPARE, 'Core 9'), peerOf(SPARE)]);
  assert.equal(spareSet[1].audible, undefined, 'the bench spare\'s critical is muted by policy, not held by a bounded mute');
  const homeSet = quietPeerSpreadUnderHeldCritical([critOf(HOME, 'Core 1'), peerOf(HOME)]);
  assert.equal(homeSet[1].audible, false, 'a home Core\'s held critical owns the audible, as before');
});
