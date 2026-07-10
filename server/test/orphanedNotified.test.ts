import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanedNotifiedIds, type NotifyRecord } from '../src/alertMonitor.js';

/* ===================================================================
 * v1.3.0 (audit rank 2) — an alert that clears while the process is DOWN.
 *
 * `persistedNotified` survives a restart; the in-memory `tracked` map does not, and the
 * falling-edge resolve loop only walks `tracked`. So such an alert:
 *   - never gets its "Resolved:" (as of v1.1.0 only a resolve DISMISSES the HA card, so the
 *     card stays up forever), and
 *   - keeps suppressing a genuine RE-FIRE for the full 24 h notified-record TTL.
 *
 * On a host that loses power daily, that is a live hole in the one push channel. Observed
 * on the msg-rate-floor family: "Device barely reporting" (SHP2) fired, the add-on restarted
 * ~66 min later, and no "Resolved:" followed in the next 13.8 h of log.
 * =================================================================== */

const rec = (over: Partial<NotifyRecord> = {}): NotifyRecord =>
  ({ ts: 1, sent: true, sev: 'warning', ...over });

const sweep = (p: {
  persisted: Map<string, NotifyRecord>;
  currentIds?: string[];
  trackedIds?: string[];
  notifyResolved?: boolean;
  minSeverity?: 'warning' | 'critical';
}) =>
  orphanedNotifiedIds({
    persisted: p.persisted,
    currentIds: new Set(p.currentIds ?? []),
    trackedIds: new Set(p.trackedIds ?? []),
    notifyResolved: p.notifyResolved ?? true,
    minSeverity: p.minSeverity ?? 'warning',
  });

test('an alert that cleared across a restart is RESOLVED, retiring its stuck HA card', () => {
  const persisted = new Map([['msg-rate-floor-SHP2', rec({ sev: 'warning' })]]);
  const { resolve, drop } = sweep({ persisted }); // not firing, not tracked
  assert.deepEqual(resolve, ['msg-rate-floor-SHP2']);
  assert.deepEqual(drop, []);
});

test('a STILL-ACTIVE alert is left completely alone', () => {
  const persisted = new Map([['soc-low-A', rec()]]);
  // Present in the live alert set...
  assert.deepEqual(sweep({ persisted, currentIds: ['soc-low-A'] }), { resolve: [], drop: [] });
  // ...or already re-tracked by the rising-edge loop.
  assert.deepEqual(sweep({ persisted, trackedIds: ['soc-low-A'] }), { resolve: [], drop: [] });
});

test('a record whose push was SUPPRESSED owes no resolve — it is merely dropped', () => {
  // sent:false means policy suppressed the fire (silenced family, priority off). No card
  // exists to dismiss, but the record must still go so it cannot eat a future fire.
  const persisted = new Map([['x', rec({ sent: false })]]);
  assert.deepEqual(sweep({ persisted }), { resolve: [], drop: ['x'] });
});

test('a record below minSeverity owes no resolve, and is dropped', () => {
  const persisted = new Map([['x', rec({ sev: 'info' })]]);
  assert.deepEqual(sweep({ persisted, minSeverity: 'warning' }), { resolve: [], drop: ['x'] });
});

test('notifyResolved=false suppresses the resolve but still frees the id', () => {
  const persisted = new Map([['x', rec()]]);
  assert.deepEqual(sweep({ persisted, notifyResolved: false }), { resolve: [], drop: ['x'] });
});

test('a system-outage EVENT never emits a resolve — it is dropped', () => {
  // isOutageEventFamily: an outage already ended when we detected it; "the past outage
  // recovered" a day later is meaningless. shouldSendResolve encodes this; we inherit it.
  const persisted = new Map([['system-outage-1783600000000', rec({ sev: 'warning' })]]);
  const { resolve, drop } = sweep({ persisted });
  assert.deepEqual(resolve, []);
  assert.deepEqual(drop, ['system-outage-1783600000000']);
});

test('every orphan is retired exactly once — resolve and drop partition the set', () => {
  const persisted = new Map<string, NotifyRecord>([
    ['live', rec()],                       // still firing
    ['owed', rec({ sev: 'critical' })],    // owes a resolve
    ['suppressed', rec({ sent: false })],  // drop only
  ]);
  const { resolve, drop } = sweep({ persisted, currentIds: ['live'] });
  assert.deepEqual(resolve, ['owed']);
  assert.deepEqual(drop, ['suppressed']);
  const touched = [...resolve, ...drop];
  assert.equal(new Set(touched).size, touched.length, 'no id retired twice');
  assert.ok(!touched.includes('live'), 'an active alert is never retired');
});
