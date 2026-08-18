import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSettingsSurface, diffSurfaces, evaluateDrift, freshDriftState,
  classifyChange, renderDriftPush, type SurfaceDevice,
} from '../src/settingsDrift.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * settingsDrift — the watchdog for invisible configuration changes (v1.83.0).
 *
 * The two motivating incidents these tests re-enact:
 *  - 2026-08-04: "Charge Now" flipped ON in the app; nothing noticed until the
 *    on-peak power flow betrayed it hours later.
 *  - 2026-08-16: a cloud-ACK'd reserve write the device never took — and no
 *    machinery watching the settings surface from the outside.
 * ═════════════════════════════════════════════════════════════════════════ */

const shp2 = (over: Record<string, unknown> = {}): SurfaceDevice => ({
  sn: 'HD31ZASAHH120432', label: 'Smart Home Panel 2', kind: 'shp2',
  raw: {
    ch1ForceCharge: 'FORCE_CHARGE_OFF', ch2ForceCharge: 'FORCE_CHARGE_OFF',
    ch3ForceCharge: 'FORCE_CHARGE_OFF', smartBackupMode: 2, backupReserveSoc: 10,
    chargeWattPower: 5600, foceChargeHight: 100, stormIsEnable: false,
    epsModeInfo: false, masterCur: 100, oilMaxOutputWatt: 3000,
    ...over,
  },
});
const dpu = (sn: string, label: string, over: Record<string, unknown> = {}): SurfaceDevice => ({
  sn, label, kind: 'dpu',
  raw: {
    'hs_yj751_pd_app_set_info_addr.sysWordMode': 0,
    'hs_yj751_pd_app_set_info_addr.sysBackupSoc': 50,
    'hs_yj751_pd_app_set_info_addr.chgC20SetWatts': 1800,
    'hs_yj751_pd_app_set_info_addr.chgMaxSoc': 100,
    'hs_yj751_pd_app_set_info_addr.dsgMinSoc': 10,
    ...over,
  },
});

test('extraction: SHP2 flat-first with pd303_mc fallback; DPU prefixed keys', () => {
  const flat = extractSettingsSurface([shp2(), dpu('Y711ZAB59GBC0314', 'Core 1')]);
  assert.equal(flat['Smart Home Panel 2 · ch1ForceCharge'], 'FORCE_CHARGE_OFF');
  assert.equal(flat['Core 1 · sysWordMode'], 0);
  // fallback: flat key absent, prefixed present
  const d = shp2(); delete (d.raw as any).smartBackupMode;
  (d.raw as any)['pd303_mc.smartBackupMode'] = 1;
  assert.equal(extractSettingsSurface([d])['Smart Home Panel 2 · smartBackupMode'], 1);
});

test('THE 08-04 SHAPE: Charge Now flipping ON is confirmed on the second sighting, not the first', () => {
  const state = freshDriftState();
  assert.equal(evaluateDrift(state, extractSettingsSurface([shp2()])).adoptedBaseline, true);
  const flipped = extractSettingsSurface([shp2({ ch2ForceCharge: 'FORCE_CHARGE_ON' })]);
  const first = evaluateDrift(state, flipped);
  assert.deepEqual(first.confirmedChanges, [], 'one sighting is a transient until proven');
  const second = evaluateDrift(state, flipped);
  assert.deepEqual(second.confirmedChanges, [{
    key: 'Smart Home Panel 2 · ch2ForceCharge', from: 'FORCE_CHARGE_OFF', to: 'FORCE_CHARGE_ON',
  }]);
  // and the baseline advanced — no re-announce on ANY later tick. Two ticks
  // matter: a broken baseline re-confirms on a 2-tick cycle (pending → confirm),
  // so checking only tick 3 would miss it (the harness's mutant v proved this).
  assert.deepEqual(evaluateDrift(state, flipped).confirmedChanges, []);
  assert.deepEqual(evaluateDrift(state, flipped).confirmedChanges, []);
  assert.deepEqual(evaluateDrift(state, flipped).confirmedChanges, []);
});

test('a one-tick transient that reverts never announces', () => {
  const state = freshDriftState();
  evaluateDrift(state, extractSettingsSurface([shp2()]));
  evaluateDrift(state, extractSettingsSurface([shp2({ chargeWattPower: 7200 })])); // blip
  const back = evaluateDrift(state, extractSettingsSurface([shp2()]));
  assert.deepEqual(back.confirmedChanges, []);
  assert.deepEqual(evaluateDrift(state, extractSettingsSurface([shp2()])).confirmedChanges, []);
});

test('OFFLINE IS NOT DRIFT: a device disappearing (Core 2) announces nothing; its return re-baselines silently', () => {
  const state = freshDriftState();
  const both = [shp2(), dpu('Y711ZAB59GBC0482', 'Core 2')];
  evaluateDrift(state, extractSettingsSurface(both));
  // Core 2 drops off — its keys vanish from the surface
  const gone = evaluateDrift(state, extractSettingsSurface([shp2()]));
  assert.deepEqual(gone.confirmedChanges, []);
  assert.deepEqual(evaluateDrift(state, extractSettingsSurface([shp2()])).confirmedChanges, []);
  // it returns with a DIFFERENT sysBackupSoc than before it left — still silent:
  // the both-sides rule diffs against the retained baseline… which kept the old
  // value, so this IS a diffable change and must confirm normally.
  const returned = [shp2(), dpu('Y711ZAB59GBC0482', 'Core 2', { 'hs_yj751_pd_app_set_info_addr.sysBackupSoc': 30 })];
  evaluateDrift(state, extractSettingsSurface(returned));
  const confirmed = evaluateDrift(state, extractSettingsSurface(returned));
  assert.deepEqual(confirmed.confirmedChanges, [{ key: 'Core 2 · sysBackupSoc', from: 50, to: 30 }],
    'a value that changed across an offline gap is a REAL change, caught on return');
});

test('OWN-WRITE: the actuator moving the reserve to its target/restore is never external', () => {
  const ctx = { targetPct: 50, priorReservePct: 10, nightActive: true };
  const up = { key: 'Smart Home Panel 2 · backupReserveSoc', from: 10 as const, to: 50 as const };
  const down = { key: 'Smart Home Panel 2 · backupReserveSoc', from: 50 as const, to: 10 as const };
  assert.equal(classifyChange(up, ctx), 'own-write');
  assert.equal(classifyChange(down, ctx), 'own-write');
  // Same movement with NO night in flight = external — the phantom-write
  // investigation's other side (something else moved our reserve).
  assert.equal(classifyChange(up, { ...ctx, nightActive: false }), 'external');
  // A reserve value that matches NEITHER actuator value is external even mid-night.
  assert.equal(classifyChange({ ...up, to: 35 }, ctx), 'external');
  // Non-reserve keys are always external regardless of the night.
  assert.equal(classifyChange({ key: 'Core 1 · chgC20SetWatts', from: 1800, to: 3900 }, ctx), 'external');
});

test('first boot with no sidecar: adoption is silent, whatever the surface holds', () => {
  const state = freshDriftState();
  const evaln = evaluateDrift(state, extractSettingsSurface([shp2({ ch1ForceCharge: 'FORCE_CHARGE_ON' })]));
  assert.equal(evaln.adoptedBaseline, true);
  assert.deepEqual(evaln.confirmedChanges, [], 'an initial surface is a baseline, not a change set');
});

test('diffSurfaces: both-sides rule, exact inequality only', () => {
  assert.deepEqual(diffSurfaces({ a: 1, b: 'x' }, { a: 1, b: 'x' }), []);
  assert.deepEqual(diffSurfaces({ a: 1 }, { a: 2, c: 9 }), [{ key: 'a', from: 1, to: 2 }]);
  assert.deepEqual(diffSurfaces({ a: 1, gone: 5 }, { a: 1 }), []);
});

test('push rendering: one line per change, old → new, batched title', () => {
  const one = renderDriftPush([{ key: 'Core 3 · chgC20SetWatts', from: 1800, to: 3900 }]);
  assert.match(one.title, /Setting changed: Core 3 · chgC20SetWatts/);
  assert.match(one.body, /1800 → 3900/);
  const many = renderDriftPush([
    { key: 'a', from: 1, to: 2 }, { key: 'b', from: 'x', to: 'y' },
  ]);
  assert.match(many.title, /2 settings changed/);
});
