import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haNotificationId } from '../src/notify.js';
import { notifyLocator } from '../src/alertMonitor.js';
import { SEVERITY_ORDER, type Alert } from '../src/alerts.js';

/* ===================================================================
 * v1.3.0 — morning-digest hygiene (audit ranks 6, 7, 9, 45).
 *
 * The operator's live config holds EVERY tier overnight, including critical
 * (CRITICAL_BREAKS_QUIET=false), so the 08:00 digest is the sole delivery for a 02:00
 * emergency. Three things were wrong with it, and one card collision.
 * =================================================================== */

/* ── rank 7: the digest and the manual "Send Test" overwrote each other ── */

test('the digest and Send Test no longer collide on one HA card id', () => {
  const digest = haNotificationId('digest', 'info');
  const sendTest = haNotificationId('test', 'info');
  assert.notEqual(digest, sendTest);
  assert.equal(digest, 'ecoflow_panel_digest');
  assert.equal(sendTest, 'ecoflow_panel_test');
  // Both used to fall through to the legacy per-severity id, so whichever landed second
  // silently REPLACED the other's card in HA's notification drawer.
  const legacy = haNotificationId(undefined, 'info');
  assert.equal(legacy, 'ecoflow_panel_info');
  assert.notEqual(digest, legacy);
  assert.notEqual(sendTest, legacy);
});

/* ── rank 6: a critical held at 02:00 must not render buried in the list ── */

test('digest ordering puts the most severe first, and is stable within a tier', () => {
  const held = [
    { id: 'w1', severity: 'warning' },
    { id: 'i1', severity: 'info' },
    { id: 'c1', severity: 'critical' },
    { id: 'w2', severity: 'warning' },
  ] as Array<Pick<Alert, 'id' | 'severity'>>;

  // This is exactly the comparator dispatchDigest applies to `pending`.
  const ordered = [...held].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  assert.deepEqual(ordered.map((a) => a.id), ['c1', 'w1', 'w2', 'i1']);
  assert.equal(ordered[0].severity, 'critical', 'a 2am critical leads the digest');
  // Stable: w1 was queued before w2 overnight, and stays before it.
  assert.ok(ordered.indexOf(held[0]) < ordered.indexOf(held[3]));
});

test('SEVERITY_ORDER really does rank critical ahead of warning ahead of info', () => {
  assert.ok(SEVERITY_ORDER.critical < SEVERITY_ORDER.warning);
  assert.ok(SEVERITY_ORDER.warning < SEVERITY_ORDER.info);
});

/* ── rank 9: identity on a digest line, for subjects that are not Cores ── */

test('the digest locator names non-Core subjects, where identity matters most', () => {
  // The old digest built its locator from coreNum alone, so an SHP2 circuit baseline
  // anomaly — which has a device but no coreNum — rendered with NO locator at all.
  const shp2Circuit = { device: 'Smart Home Panel 2', coreNum: null, packNum: null } as any;
  assert.equal(notifyLocator(shp2Circuit), 'Smart Home Panel 2');

  // Core/pack subjects keep their precise identity.
  assert.equal(notifyLocator({ device: 'Core 3', coreNum: 3, packNum: 4 } as any), 'Core 3 pack 4');

  // System-wide alerts stay locator-free, so their lines are unchanged.
  assert.equal(notifyLocator({ device: 'System', coreNum: null, packNum: null } as any), '');
  assert.equal(notifyLocator({ device: 'EcoFlow Cloud', coreNum: null, packNum: null } as any), '');
});
