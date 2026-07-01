import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSocResolveDwellFamily,
  isCellImbalanceResolveDwellFamily,
  notifyLocator,
  notifyDedupId,
} from '../src/alertMonitor.js';
import { haNotificationId } from '../src/notify.js';
import type { Alert } from '../src/alerts.js';

/* v0.74.0 — notification-hygiene bundle. All three audit items are notify-layer
 * only and provably alarm-firing-neutral; these tests pin the pure pieces. */

function a(over: Partial<Alert> & Pick<Alert, 'id'>): Alert {
  return {
    severity: 'warning',
    category: 'Battery',
    device: 'System',
    title: 'Pack nearly empty',
    detail: '',
    ...over,
  };
}

/* ── item 1: resolve-side dwell family predicate ─────────────────────────── */

test('isSocResolveDwellFamily — matches the soc-low pack family only', () => {
  assert.equal(isSocResolveDwellFamily({ id: 'soc-low-HD31ZAS-1' }), true);
  assert.equal(isSocResolveDwellFamily({ id: 'soc-low-R3PLUS123-2' }), true);
  // Other families keep immediate resolve — not in scope.
  assert.equal(isSocResolveDwellFamily({ id: 'dpu-err-GBC0314' }), false);
  assert.equal(isSocResolveDwellFamily({ id: 'baseline-ch1_w-SN' }), false);
  assert.equal(isSocResolveDwellFamily({ id: 'cell-imbalance-SN-3' }), false);
  assert.equal(isSocResolveDwellFamily({ id: 'shp2-below-reserve' }), false);
});

test('v0.77.0 — isCellImbalanceResolveDwellFamily matches the vdiff warn/crit family only', () => {
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'vdiff-warn-Y711FAB59J234000-1' }), true);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'vdiff-crit-HD31ZAS-2' }), true);
  // Not the soc-low family (that has its own dwell) and not other families.
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'soc-low-HD31ZAS-1' }), false);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'dpu-err-GBC0314' }), false);
  assert.equal(isCellImbalanceResolveDwellFamily({ id: 'vdiff-something-else' }), false);
  // The two dwell families are disjoint (each gets its own resolve-dwell block).
  assert.equal(
    isSocResolveDwellFamily({ id: 'vdiff-warn-x-1' }) || isCellImbalanceResolveDwellFamily({ id: 'soc-low-x-1' }),
    false,
  );
});

/* ── item 2a: human-facing device locator ────────────────────────────────── */

test('notifyLocator — device + pack render for a per-pack alert', () => {
  assert.equal(notifyLocator(a({ id: 'soc-low-x-1', device: 'RIVER 3 Plus', packNum: 1 })), 'RIVER 3 Plus pack 1');
  assert.equal(notifyLocator(a({ id: 'soc-low-y-2', device: 'Delta 3 Plus', packNum: 2 })), 'Delta 3 Plus pack 2');
});

test('notifyLocator — RIVER 3 Plus and Delta 3 Plus produce DISTINCT locators', () => {
  const river = notifyLocator(a({ id: 'soc-low-r-1', device: 'RIVER 3 Plus', packNum: 1 }));
  const delta = notifyLocator(a({ id: 'soc-low-d-1', device: 'Delta 3 Plus', packNum: 1 }));
  assert.notEqual(river, delta);
});

test('notifyLocator — falls back to Core N when device is generic', () => {
  assert.equal(notifyLocator(a({ id: 'mppt-hot-3', device: 'System', coreNum: 3 })), 'Core 3');
  assert.equal(notifyLocator(a({ id: 'temp-hot-3-2', device: 'System', coreNum: 3, packNum: 2 })), 'Core 3 pack 2');
});

test('notifyLocator — system-wide alerts get an empty locator (clean titles)', () => {
  assert.equal(notifyLocator(a({ id: 'grid-offgrid', device: 'System' })), '');
  assert.equal(notifyLocator(a({ id: 'cloud-session-stale', device: 'EcoFlow Cloud' })), '');
});

/* ── item 2b: per-subject notification identity ──────────────────────────── */

test('notifyDedupId — uses the SN-bearing alert id, so distinct packs are distinct', () => {
  const p1 = notifyDedupId({ id: 'soc-low-HD31ZAS-1' });
  const p2 = notifyDedupId({ id: 'soc-low-G9P0090-1' });
  const p3 = notifyDedupId({ id: 'soc-low-R3PLUS-1' });
  assert.equal(new Set([p1, p2, p3]).size, 3);
});

test('haNotificationId — three packs map to THREE distinct HA cards (was one)', () => {
  const ids = ['soc-low-HD31ZAS-1', 'soc-low-G9P0090-1', 'soc-low-R3PLUS-1'].map((id) =>
    haNotificationId(notifyDedupId({ id }), 'warning'),
  );
  assert.equal(new Set(ids).size, 3, 'each pack must get its own card');
  // Regression guard: the old behaviour collapsed all of them onto this one id.
  assert.ok(ids.every((x) => x !== 'ecoflow_panel_warning'));
});

test('haNotificationId — a Resolved send reuses the fire-side id (updates same card)', () => {
  const fire = haNotificationId(notifyDedupId({ id: 'soc-low-HD31ZAS-1' }), 'warning');
  const resolved = haNotificationId(notifyDedupId({ id: 'soc-low-HD31ZAS-1' }), 'resolved');
  assert.equal(fire, resolved);
});

test('haNotificationId — no dedupId falls back to the legacy per-severity id', () => {
  assert.equal(haNotificationId(undefined, 'warning'), 'ecoflow_panel_warning');
  assert.equal(haNotificationId(undefined, 'critical'), 'ecoflow_panel_critical');
  assert.equal(haNotificationId('', 'info'), 'ecoflow_panel_info');
});

test('haNotificationId — arbitrary ids reduce to HA-safe [a-z0-9_], length-capped', () => {
  const id = haNotificationId('SOC-Low: Pack#1 (Delta 3+) @ 5%!', 'warning');
  assert.match(id, /^ecoflow_panel_[a-z0-9_]+$/);
  assert.ok(id.length <= 'ecoflow_panel_'.length + 96);
  // An all-symbol dedupId must not collapse to a bare prefix.
  assert.equal(haNotificationId('@#$%', 'critical'), 'ecoflow_panel_critical');
});
