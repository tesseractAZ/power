import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReserveArbitrageRaised, setReserveArbitrageRaised, resetReserveArbitrageRaised,
} from '../src/nightChargeActuator.js';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.113.0 — the below-reserve severity discriminator.
 *
 * MOTIVATING CHANGE (2026-08-28): the owner raised the SHP2 reserve floor from
 * 10% to 20% for more outage buffer. The old code decided "true floor" vs
 * "arbitrage-raised by the night-charge write" with `reserve <= 15` — a proxy
 * that holds only while the owner's floor sits below 15. At a floor of 20 the
 * proxy INVERTS: a genuine breach of the new, more conservative floor would be
 * classified as charge-window filling and drop from a pushed warning to silent
 * info. Asking for more protection would have bought less.
 *
 * The discriminator is now the actuator's posture — did WE raise it — which is
 * a fact the actuator records and persists.
 */

const SHP2 = 'HD31ZASAHH120432';
const fleet = (poolPct: number, reservePct: number): Record<string, DeviceSnapshot> => ({
  [SHP2]: {
    sn: SHP2, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2',
    online: true, lastSeenMs: Date.now(),
    // sources drives a SEPARATE slot-error loop downstream of the branch under
    // test; empty is the honest fixture here, not hidden coverage.
    projection: { kind: 'shp2', backupBatPercent: poolPct, backupReserveSoc: reservePct, sources: [], pairedCircuits: [] } as any,
  } as any,
});
const onGrid = { present: true, backstopping: true };
const offGrid = { present: false, backstopping: false };
const below = (alerts: any[]) => alerts.find((a) => a.id === 'shp2-below-reserve');

beforeEach(() => resetReserveArbitrageRaised());

test('predicate: raised iff applied and not yet reverted', () => {
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: null, revertedAtMs: null }), false, 'never applied');
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: 1_000, revertedAtMs: null }), true, 'write in flight');
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: 1_000, revertedAtMs: 2_000 }), false, 'reverted');
});

test('★ THE 20% CASE: a genuine breach of a RAISED owner floor still pushes', () => {
  // Owner floor 20, pool at 18, grid up, no night-charge write in flight.
  setReserveArbitrageRaised(false);
  const a = below(computeAlerts(fleet(18, 20), undefined, onGrid));
  assert.ok(a, 'alert present');
  assert.equal(a!.severity, 'warning', 'a real floor breach must not be downgraded to info');
  assert.equal(a!.priority, 'medium', 'and it must carry the once-per-episode push');
});

test('the old proxy would have failed this exact case', () => {
  // Documents the regression the fix prevents: reserve 20 > 15, so the
  // pre-v1.113.0 rule (`reserve <= 15`) produced info + no push here.
  const reserve = 20;
  assert.equal(reserve <= 15, false, 'the retired proxy classifies the owner floor as arbitrage');
});

test('arbitrage window: pool below a night-charge-raised reserve stays silent info (F14 preserved)', () => {
  setReserveArbitrageRaised(true);
  const a = below(computeAlerts(fleet(30, 50), undefined, onGrid));
  assert.ok(a, 'still visible on screen');
  assert.equal(a!.severity, 'info', 'the charge window filling the pool must not page');
  assert.equal(a!.priority, undefined);
});

test('the legacy 10% floor keeps its v1.81.0 behavior', () => {
  setReserveArbitrageRaised(false);
  const a = below(computeAlerts(fleet(9, 10), undefined, onGrid));
  assert.equal(a!.severity, 'warning');
  assert.equal(a!.priority, 'medium');
});

test('off-grid is critical regardless of posture — both ways', () => {
  setReserveArbitrageRaised(false);
  assert.equal(below(computeAlerts(fleet(18, 20), undefined, offGrid))!.severity, 'critical');
  setReserveArbitrageRaised(true);
  assert.equal(below(computeAlerts(fleet(30, 50), undefined, offGrid))!.severity, 'critical',
    'an outage during the charge window is still an emergency');
});

test('inclusive floor comparison survives (v1.17.0 F14): pool EXACTLY at the floor alerts', () => {
  setReserveArbitrageRaised(false);
  assert.ok(below(computeAlerts(fleet(20, 20), undefined, onGrid)), 'pool == reserve must alert');
});

// ── v1.114.0: the owner reserve-floor guard (pure parts) ────────────────────
import { clampReserveTarget } from '../src/nightChargeActuator.js';

test('owner floor: the [10,50] envelope is the device clamp, unchanged', () => {
  assert.equal(clampReserveTarget(20), 20, 'the new owner floor is inside the envelope');
  assert.equal(clampReserveTarget(9), 10);
  assert.equal(clampReserveTarget(60), 50);
});

test('owner floor: a mid-window change must be refused — the revert would undo it', () => {
  // The endpoint refuses when isReserveArbitrageRaised(state) is true. Pinning
  // the predicate that gates it: the actuator restores priorReservePct at
  // window close, so a floor change applied underneath a live write would be
  // silently reverted to the OLD floor hours later.
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: 1_000, revertedAtMs: null }), true, 'refuse');
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: 1_000, revertedAtMs: 2_000 }), false, 'allow after revert');
  assert.equal(isReserveArbitrageRaised({ appliedAtMs: null, revertedAtMs: null }), false, 'allow when idle');
});
