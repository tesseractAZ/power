import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateFloorAlerts,
  rateFloorAlertId,
  isRateFloorAlert,
  getRateFloorCollapses,
  setRateFloorCollapses,
  resetRateFloorCollapses,
  type RateFloorCollapse,
} from '../src/messageRateFloorAlert.js';

/**
 * v0.93.0 (audit #1 phase-2) — the message-rate-floor collapse is promoted from a
 * WARN log to a real WARNING push alert that rides the SAME notify pipeline as the
 * offline/stale alerts. These pin the pure builder + the set/get state channel.
 */

const collapse = (over: Partial<RateFloorCollapse> = {}): RateFloorCollapse => ({
  sn: 'SHP2SN', deviceName: 'Home Panel', rate: 0.2, baseline: 30, ...over,
});

test('one WARNING push alert per collapsing device, stable id, NOT annunciate:false', () => {
  const alerts = rateFloorAlerts([collapse()]);
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.id, rateFloorAlertId('SHP2SN'));
  assert.equal(a.id, 'msg-rate-floor-SHP2SN');
  assert.equal(a.severity, 'warning');
  assert.equal(a.category, 'Connectivity');
  assert.equal(a.priority, 'medium');
  assert.equal(a.device, 'Home Panel');
  // Must ride the working push channel like offline/stale — never suppressed.
  assert.notEqual(a.annunciate, false);
  assert.match(a.detail, /0\.2 msg\/min/);
  assert.match(a.detail, /~30 msg\/min/);
});

test('empty collapse set → no alerts', () => {
  assert.deepEqual(rateFloorAlerts([]), []);
});

test('id is stable across ticks (dedup) for the same device', () => {
  const a1 = rateFloorAlerts([collapse({ rate: 0.3 })])[0];
  const a2 = rateFloorAlerts([collapse({ rate: 0.1 })])[0];
  assert.equal(a1.id, a2.id, 'same SN → same id across ticks so the notify path de-dups');
});

test('multiple collapsing devices → one alert each, distinct ids', () => {
  const alerts = rateFloorAlerts([
    collapse({ sn: 'A', deviceName: 'Core 1' }),
    collapse({ sn: 'B', deviceName: 'Core 2' }),
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(new Set(alerts.map((a) => a.id)), new Set(['msg-rate-floor-A', 'msg-rate-floor-B']));
});

test('null live rate renders a placeholder, not NaN', () => {
  const a = rateFloorAlerts([collapse({ rate: null })])[0];
  assert.match(a.detail, /\? msg\/min/);
  assert.doesNotMatch(a.detail, /NaN/);
  assert.equal(a.facts?.[0].value, '—');
});

test('isRateFloorAlert matches only the family', () => {
  assert.equal(isRateFloorAlert({ id: 'msg-rate-floor-XYZ' }), true);
  assert.equal(isRateFloorAlert({ id: 'offline-XYZ' }), false);
  assert.equal(isRateFloorAlert({ id: 'stale-XYZ' }), false);
});

test('set/get/reset state channel round-trips', () => {
  resetRateFloorCollapses();
  assert.deepEqual(getRateFloorCollapses(), []);
  const c = [collapse()];
  setRateFloorCollapses(c);
  assert.deepEqual(getRateFloorCollapses(), c);
  // The alert engine reads getRateFloorCollapses() and builds from it identically.
  assert.deepEqual(rateFloorAlerts(getRateFloorCollapses()), rateFloorAlerts(c));
  resetRateFloorCollapses();
  assert.deepEqual(getRateFloorCollapses(), []);
});
