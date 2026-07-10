import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haNotifyCall, haNotificationId, type NotifyMessage } from '../src/notify.js';

/* ===================================================================
 * v1.1.0 — HA's notification drawer must show ACTIVE conditions.
 *
 * A "Resolved:" send used to re-create the same card, so a cleared condition sat in
 * HA's notification section forever. Observed live on the running system:
 *
 *   id      ecoflow_panel_baseline_pair6_w_hd31zasahh120432
 *   title   "EcoFlow · Resolved: West Air conditioner load unusual for the hour"
 *   message "... (condition cleared)"
 *
 * A drawer full of resolved cards trains the operator to ignore it. The resolve record
 * already lives in the app's cleared-anomalies log.
 * =================================================================== */

const msg = (over: Partial<NotifyMessage>): NotifyMessage =>
  ({ title: 't', body: 'b', severity: 'warning', ...over }) as NotifyMessage;

test('a RESOLVE with a dedupId dismisses the exact card it fired on', () => {
  const fireId = 'baseline-pair6_w-HD31ZASAHH120432';
  const fire = haNotifyCall(msg({ severity: 'warning', dedupId: fireId }));
  const resolve = haNotifyCall(msg({ severity: 'resolved', dedupId: fireId }));

  assert.equal(fire.service, 'create');
  assert.equal(resolve.service, 'dismiss');
  // The id must match exactly, or we'd dismiss nothing (or worse, the wrong card).
  assert.equal(resolve.notificationId, fire.notificationId);
  assert.equal(fire.notificationId, 'ecoflow_panel_baseline_pair6_w_hd31zasahh120432');
});

test('an ACTIVE alert of any severity still creates/updates its card', () => {
  for (const severity of ['info', 'warning', 'critical'] as const) {
    assert.equal(haNotifyCall(msg({ severity, dedupId: 'soc-low-ABC' })).service, 'create');
  }
});

test('a RESOLVE without a dedupId falls back to creating a card (never guess an id)', () => {
  // Without a dedupId the fire used a per-severity id we cannot reconstruct from
  // 'resolved', so dismissing would target the wrong card — or nothing.
  const r = haNotifyCall(msg({ severity: 'resolved', dedupId: undefined }));
  assert.equal(r.service, 'create');
  assert.equal(r.notificationId, 'ecoflow_panel_resolved');
});

test('distinct subjects keep distinct cards (v0.74.0 behaviour preserved)', () => {
  const a = haNotifyCall(msg({ severity: 'warning', dedupId: 'pack-empty-SN1' })).notificationId;
  const b = haNotifyCall(msg({ severity: 'warning', dedupId: 'pack-empty-SN2' })).notificationId;
  assert.notEqual(a, b);
});

test('the dismiss id is severity-independent, so any tier resolves its own card', () => {
  const id = 'dpu-pvh-err-Y711FAB59J234000';
  assert.equal(haNotificationId(id, 'critical'), haNotificationId(id, 'resolved'));
});
