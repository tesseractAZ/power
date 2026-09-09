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
  /** v1.140.0 — ids whose source device is absent/stale. Default: none, so the
   *  pre-existing contracts below read exactly as they always did. */
  unevaluableIds?: string[];
  nowMs?: number;
  holdUntilMs?: number;
}) =>
  orphanedNotifiedIds({
    persisted: p.persisted,
    currentIds: new Set(p.currentIds ?? []),
    trackedIds: new Set(p.trackedIds ?? []),
    notifyResolved: p.notifyResolved ?? true,
    minSeverity: p.minSeverity ?? 'warning',
    nowMs: p.nowMs ?? 0,
    holdUntilMs: p.holdUntilMs ?? Number.MAX_SAFE_INTEGER,
    unevaluable: (id) => (p.unevaluableIds ?? []).includes(id),
  });

test('an alert that cleared across a restart is RESOLVED, retiring its stuck HA card', () => {
  // v1.75.0 — the exemplar changed from msg-rate-floor-SHP2 to a soc-low id: the
  // starvation family is now ALWAYS dropped at boot (rates are unknowable in the
  // boot window, and on 08-05 two restarts each emitted "Resolved: barely
  // reporting" while the Cores were still starved at 2-6 msg/min). The general
  // cleared-across-restart contract this test pins is unchanged.
  const persisted = new Map([['soc-low-SHP2-1', rec({ sev: 'warning' })]]);
  const { resolve, drop } = sweep({ persisted }); // not firing, not tracked
  assert.deepEqual(resolve, ['soc-low-SHP2-1']);
  assert.deepEqual(drop, []);
});

test('v1.75.0 — a msg-rate-floor orphan is DROPPED at boot, never resolve-pushed', () => {
  const persisted = new Map([['msg-rate-floor-SHP2', rec({ sev: 'warning' })]]);
  const { resolve, drop } = sweep({ persisted });
  assert.deepEqual(resolve, []);
  assert.deepEqual(drop, ['msg-rate-floor-SHP2']);
});

test('a STILL-ACTIVE alert is left completely alone', () => {
  const persisted = new Map([['soc-low-A', rec()]]);
  // Present in the live alert set...
  assert.deepEqual(sweep({ persisted, currentIds: ['soc-low-A'] }), { hold: [], resolve: [], drop: [] });
  // ...or already re-tracked by the rising-edge loop.
  assert.deepEqual(sweep({ persisted, trackedIds: ['soc-low-A'] }), { hold: [], resolve: [], drop: [] });
});

test('a record whose push was SUPPRESSED owes no resolve — it is merely dropped', () => {
  // sent:false means policy suppressed the fire (silenced family, priority off). No card
  // exists to dismiss, but the record must still go so it cannot eat a future fire.
  const persisted = new Map([['x', rec({ sent: false })]]);
  assert.deepEqual(sweep({ persisted }), { hold: [], resolve: [], drop: ['x'] });
});

test('a record below minSeverity owes no resolve, and is dropped', () => {
  const persisted = new Map([['x', rec({ sev: 'info' })]]);
  assert.deepEqual(sweep({ persisted, minSeverity: 'warning' }), { hold: [], resolve: [], drop: ['x'] });
});

test('notifyResolved=false suppresses the resolve but still frees the id', () => {
  const persisted = new Map([['x', rec()]]);
  assert.deepEqual(sweep({ persisted, notifyResolved: false }), { hold: [], resolve: [], drop: ['x'] });
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

/* ─── v1.140.0 — S2: an orphan on an UNEVALUABLE device is HELD ───────────── */

test('★ THE DEFECT: a standing fault on a cloud-dark Core is HELD, not resolved', () => {
  // computeAlerts skips offline DPUs wholesale, so a Core merely cloud-dark at
  // boot contributes ZERO alerts and every standing fault on it looked like an
  // orphan. The operator got "Resolved: Battery protection fault" on their phone
  // and the HA card was dismissed — for a CRITICAL that had not cleared.
  const persisted = new Map([['dpu-err-CORE4', rec({ sev: 'critical', title: 'Battery protection fault' })]]);
  const { resolve, drop, hold } = sweep({ persisted, unevaluableIds: ['dpu-err-CORE4'] });
  assert.deepEqual(hold, ['dpu-err-CORE4']);
  assert.deepEqual(resolve, [], 'an unevaluable source is never a recovery');
  assert.deepEqual(drop, []);
});

test('★ the SN-less exemplar: an SHP2 source alert is held too', () => {
  // fallingEdgeFrozenByEvidence falls back to scanning the id, which yields null
  // for shp2-src-err-<slot> — the alarm data source's OWN alerts, and the SN-less
  // hole v1.78.0 closed once for the live path. The persisted sourceSn is what
  // closes it here.
  const persisted = new Map([['shp2-src-err-3', rec({ sev: 'critical', sourceSn: 'HD31ZAB1ZH8Z0018' })]]);
  const { resolve, hold } = sweep({ persisted, unevaluableIds: ['shp2-src-err-3'] });
  assert.deepEqual(hold, ['shp2-src-err-3']);
  assert.deepEqual(resolve, []);
});

test('an evaluable source still RESOLVES — the existing contract is intact', () => {
  const persisted = new Map([['dpu-err-CORE4', rec({ sev: 'critical' })]]);
  const { resolve, hold } = sweep({ persisted, unevaluableIds: [] });
  assert.deepEqual(resolve, ['dpu-err-CORE4']);
  assert.deepEqual(hold, []);
});

test('a never-PUSHED record is DROPPED even when unevaluable, never held', () => {
  // sent:false — a spare, an annunciate:false alert, an auto-downgrade. It cannot
  // produce a false all-clear, and holding it would turn the sweep into a garbage
  // collector that never collects for exactly the noisiest families.
  const persisted = new Map([['soc-low-SPARE-1', rec({ sent: false })]]);
  const { resolve, drop, hold } = sweep({ persisted, unevaluableIds: ['soc-low-SPARE-1'] });
  assert.deepEqual(drop, ['soc-low-SPARE-1']);
  assert.deepEqual(hold, []);
  assert.deepEqual(resolve, []);
});

test('★ hold EXPIRY drops silently — it never becomes a resolve', () => {
  // Several devices are permanently unevaluable: an RMA'd Core (setDeviceList
  // never deletes), a bench spare whose offline state is by design, and the 1006
  // accessories which report online:true with lastUpdated:0. The deadline stops
  // their cards lingering forever — but there is still no evidence to resolve on,
  // which is the v1.75.0 msg-rate-floor doctrine exactly.
  const persisted = new Map([['dpu-err-CORE4', rec({ sev: 'critical' })]]);
  const { resolve, drop, hold } = sweep({
    persisted, unevaluableIds: ['dpu-err-CORE4'], nowMs: 10_000, holdUntilMs: 10_000,
  });
  assert.deepEqual(drop, ['dpu-err-CORE4']);
  assert.deepEqual(hold, []);
  assert.deepEqual(resolve, [], 'expiry must DROP, never resolve');
});

test('the msg-rate-floor exemption outranks the hold', () => {
  const persisted = new Map([['msg-rate-floor-CORE4', rec()]]);
  const { drop, hold } = sweep({ persisted, unevaluableIds: ['msg-rate-floor-CORE4'] });
  assert.deepEqual(drop, ['msg-rate-floor-CORE4']);
  assert.deepEqual(hold, []);
});

test('a held id is re-offered on a later sweep once its device returns', () => {
  // The caller keeps the sweep open while anything is held (orphanSweepDone =
  // hold.length === 0). If the second pass did not resolve, the record would be
  // stranded and the fix invisible after the first tick.
  const persisted = new Map([['dpu-err-CORE4', rec({ sev: 'critical' })]]);
  assert.deepEqual(sweep({ persisted, unevaluableIds: ['dpu-err-CORE4'] }).hold, ['dpu-err-CORE4']);
  assert.deepEqual(sweep({ persisted, unevaluableIds: [] }).resolve, ['dpu-err-CORE4']);
});
