/**
 * v1.174.0 — the sunrise MPPT false alarm.
 *
 * 2026-09-22: one home Core reported HV error code 457 at 407 W / 301 V / 1.38 A for
 * ~60 s at 06:58, and again at 07:33. Both raised a warning, both were SPOKEN over the
 * house, and both were gone by the next tick (an identical 60 s blip at 06:43 on
 * 2026-08-30). Code 457 is the benign standby status EcoFlow reports on a shedding
 * string — proven at sunset, where every Core reports it simultaneously, which a real
 * fault cannot do.
 *
 * The pre-existing guard (mpptProducing: real watts AND real amps) was derived entirely
 * from SUNSET, where a shedding string makes no watts. At SUNRISE the same benign code
 * rides a string that is genuinely producing, so the guard passes it. The alarm now also
 * requires the code to STAND for MPPT_ERR_DEBOUNCE_MS while producing.
 *
 * Two halves are tested here:
 *   1. alerts.ts  — the WARNING is held while the code is inside its window.
 *   2. snapshot.ts — the clock that window is measured against runs ONLY while the code
 *      is non-zero AND the string is producing. That is what stops an all-night standby
 *      code from ageing past the window before the sun rises — the failure mode a naive
 *      "code has been non-zero for 3 minutes" clock would have shipped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { SnapshotStore } from '../src/snapshot.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { mpptProducing, MPPT_WATT_FLOOR, MPPT_AMP_FLOOR } from '../src/mppt.js';

const now = Date.now();
const MIN = 60_000;

/** The live 07:33 reading: producing 407 W at 301 V / 1.38 A with HV code 457. */
function dpu(opts: { hvCode?: number; hvWatts?: number; hvAmps?: number; lvCode?: number; lvWatts?: number; lvAmps?: number } = {}): Record<string, DeviceSnapshot> {
  const { hvCode = 457, hvWatts = 407, hvAmps = 1.38, lvCode = 0, lvWatts = 0, lvAmps = 0 } = opts;
  return {
    'DPU-1': {
      sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: now,
      projection: {
        kind: 'dpu', soc: 79, packs: [],
        pvHighWatts: hvWatts, pvLowWatts: lvWatts, pvTotalWatts: hvWatts + lvWatts,
        pvHighVolts: 301, pvHighAmps: hvAmps, pvLowVolts: 120, pvLowAmps: lvAmps,
        pvHighErrCode: hvCode, pvLowErrCode: lvCode,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode: 0, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
        chgMaxSoc: 100, dsgMinSoc: 10,
      } as any,
    } as DeviceSnapshot,
  };
}

function conn(mpptErrOnsetByKey: Map<string, { code: number; sinceMs: number }>) {
  return { lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now, perDevice: new Map(), mpptErrOnsetByKey };
}

const hvErr = (a: Alert[]) => a.find((x) => x.id === 'dpu-pvh-err-DPU-1');
const lvErr = (a: Alert[]) => a.find((x) => x.id === 'dpu-pvl-err-DPU-1');

const quota = (hvCode: number, hvWatts: number, hvAmps: number) => ({
  'hs_yj751_pd_appshow_addr.soc': 79,
  'hs_yj751_pd_appshow_addr.inHvMpptPwr': hvWatts,
  'hs_yj751_pd_appshow_addr.inLvMpptPwr': 0,
  'hs_yj751_pd_backend_addr.inHvMpptVol': 301,
  'hs_yj751_pd_backend_addr.inHvMpptAmp': hvAmps,
  'hs_yj751_pd_backend_addr.inLvMpptVol': 0,
  'hs_yj751_pd_backend_addr.inLvMpptAmp': 0,
  'hs_yj751_pd_backend_addr.hvPvErrCode': hvCode,
  'hs_yj751_pd_backend_addr.lvPvErrCode': 0,
});

function storeAt(t: () => number) {
  const store = new SnapshotStore();
  store.setClock(t);
  store.setDeviceList([{ sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra', online: 1 } as any]);
  return store;
}

/* ══ 1. the alarm holds until the code has stood ═══════════════════════════ */

test('★★★ the 60 s sunrise blip is SUPPRESSED — producing is no longer sufficient', () => {
  const alerts = computeAlerts(dpu(), conn(new Map([['DPU-1:hv', { code: 457, sinceMs: now - 60_000 }]])));
  assert.equal(hvErr(alerts), undefined, 'a code one minute old never reaches the speakers');
});

test('a SUSTAINED code (> 3 min) still fires the warning — the alarm is delayed, not lost', () => {
  const alerts = computeAlerts(dpu(), conn(new Map([['DPU-1:hv', { code: 457, sinceMs: now - 4 * MIN }]])));
  const a = hvErr(alerts);
  assert.ok(a, 'a string that keeps reporting the code while producing still alarms');
  assert.equal(a!.severity, 'warning');
  assert.match(a!.detail, /error code 457/);
});

test('a code CHANGE re-baselines — a different code is a different fault and serves its own window', () => {
  // Driven through the real chain: the store stamps the onset on the same ingest that
  // produces the projection the engine reads, so a changed code is always paired with a
  // freshly-stamped window rather than inheriting the previous code's elapsed time.
  let t = now - 10 * MIN;
  const store = storeAt(() => t);
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38));
  t = now;
  store.setDeviceQuota('DPU-1', quota(461, 407, 1.38));  // a genuinely different fault
  const onset = store.mpptErrOnsets().get('DPU-1:hv')!;
  assert.equal(onset.code, 461);
  assert.equal(onset.sinceMs, now, 'the new code starts its own window');
  const alerts = computeAlerts(dpu({ hvCode: 461 }), conn(store.mpptErrOnsets()));
  assert.equal(hvErr(alerts), undefined, 'the elapsed 457 window cannot be inherited by 461');
});

test('the LV string has its own independent window (one key per string, not per device)', () => {
  const both = dpu({ hvCode: 457, lvCode: 177, lvWatts: 300, lvAmps: 2.5 });
  const alerts = computeAlerts(both, conn(new Map([
    ['DPU-1:hv', { code: 457, sinceMs: now - 30_000 }],   // fresh → held
    ['DPU-1:lv', { code: 177, sinceMs: now - 9 * MIN }],  // stood → fires
  ])));
  assert.equal(hvErr(alerts), undefined, 'HV is inside its window');
  assert.ok(lvErr(alerts), 'LV stood for its own window and is not muted by HV');
});

test('a fresh LV code is held by its own window too (both strings are guarded, not just HV)', () => {
  const alerts = computeAlerts(dpu({ hvCode: 0, lvCode: 177, lvWatts: 300, lvAmps: 2.5 }),
    conn(new Map([['DPU-1:lv', { code: 177, sinceMs: now - 30_000 }]])));
  assert.equal(lvErr(alerts), undefined, 'the LV guard is not a copy-paste of the HV one that forgot to fire');
});

test('no onset context (older callers/tests) fires immediately — a missing map never mutes a real fault', () => {
  const alerts = computeAlerts(dpu());
  assert.ok(hvErr(alerts), 'pre-v1.174.0 behaviour is preserved when the map is absent');
});

test('a standby code on a NON-producing string is still rejected outright (the sunset case)', () => {
  // 0 W / 0.275 A shutdown trickle — the v0.9.81 signature. No onset, no alert, and the
  // debounce never even comes into it.
  const alerts = computeAlerts(dpu({ hvWatts: 0, hvAmps: 0.275 }), conn(new Map()));
  assert.equal(hvErr(alerts), undefined);
  assert.equal(mpptProducing(0, 0.275), false, 'the producing test still owns the sunset case');
  assert.equal(mpptProducing(MPPT_WATT_FLOOR + 1, MPPT_AMP_FLOOR + 0.1), true);
});

test('a trickle of real current at a few watts is NOT producing — the watt floor still carries weight', () => {
  // 5 W at 0.5 A passes the amp floor: only the watt floor rejects it. Without that floor
  // the sunset/curtailment shed reads as production and the standby code alarms again.
  assert.equal(mpptProducing(5, 0.5), false, 'below the watt floor is idle, whatever the amps say');
  assert.equal(mpptProducing(MPPT_WATT_FLOOR, 0.5), false, 'the floor itself is not producing');
  const alerts = computeAlerts(dpu({ hvWatts: 5, hvAmps: 0.5 }), conn(new Map()));
  assert.equal(hvErr(alerts), undefined, 'and the alarm engine agrees, with no onset context at all');
});

/* ══ 2. the clock only runs while the alarm condition holds ════════════════ */

test('★★★ an all-night standby code banks NO debounce time — the clock needs watts too', () => {
  // Wall-clock honest: dusk is 7 h before now, sunrise 1 min before now, so the onset the
  // alarm engine reads is measured against the SAME Date.now() computeAlerts uses.
  let t = now - 7 * 60 * MIN;
  const store = storeAt(() => t);
  store.setDeviceQuota('DPU-1', quota(457, 0, 0));      // dusk: code stands on a dark string
  t += 6 * 60 * MIN;
  store.setDeviceQuota('DPU-1', quota(457, 0, 0));      // still dark, six hours later
  assert.equal(store.mpptErrOnsets().get('DPU-1:hv'), undefined, 'a dark string never starts the clock');

  t = now - MIN;                                        // sunrise: the same code, now producing
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38));
  const onset = store.mpptErrOnsets().get('DPU-1:hv');
  assert.ok(onset, 'production starts the clock');
  assert.equal(onset!.code, 457);
  assert.equal(onset!.sinceMs, now - MIN, 'stamped when it began producing, not at dusk');

  // One minute old — the live 06:58 case — and now silent.
  const alerts = computeAlerts(dpu(), conn(store.mpptErrOnsets()));
  assert.equal(hvErr(alerts), undefined, 'the blip that spoke at 06:58 is held');
});

test('the clock resets when the string stops producing, so an intermittent code restarts its window', () => {
  let t = now - 10 * MIN;
  const store = storeAt(() => t);
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38));
  const first = store.mpptErrOnsets().get('DPU-1:hv')!.sinceMs;
  t += 2 * MIN;
  store.setDeviceQuota('DPU-1', quota(457, 0, 0));      // shed — clock dropped
  assert.equal(store.mpptErrOnsets().get('DPU-1:hv'), undefined);
  t += MIN;
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38)); // back — a NEW window
  const second = store.mpptErrOnsets().get('DPU-1:hv')!.sinceMs;
  assert.equal(second, t);
  assert.ok(second > first, 'the interrupted window is not resumed');
});

test('a code that clears drops the entry (no stale onset can debounce a later, different fault)', () => {
  let t = now - 5 * MIN;
  const store = storeAt(() => t);
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38));
  assert.ok(store.mpptErrOnsets().get('DPU-1:hv'));
  t += MIN;
  store.setDeviceQuota('DPU-1', quota(0, 407, 1.38));
  assert.equal(store.mpptErrOnsets().get('DPU-1:hv'), undefined);
});

test('a code producing continuously for 5 minutes DOES alarm, driven by the store clock', () => {
  let t = now - 5 * MIN;
  const store = storeAt(() => t);
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38));
  t = now - MIN;
  store.setDeviceQuota('DPU-1', quota(457, 407, 1.38)); // same code, still producing
  assert.equal(store.mpptErrOnsets().get('DPU-1:hv')!.sinceMs, now - 5 * MIN, 'onset is not re-stamped while it stands');
  const alerts = computeAlerts(dpu(), conn(store.mpptErrOnsets()));
  assert.ok(hvErr(alerts), 'past the window, the real-fault path is intact end to end');
});
