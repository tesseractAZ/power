/**
 * v1.187.0 — auto-tune never drops an OWED resolve.
 *
 * 09-29 05:00:10: three LV-MPPT alerts cleared in one tick. "Resolved: … Core 1" and "… Core 2"
 * were sent; retiring those two clears took the family's long-active count from 3/10 to 5/10,
 * Rule 3 latched mid-tick, and Core 5's resolve was suppressed — although its rise had been
 * pushed as "[Medium] …" the day before. The resolve is what dismisses the HA drawer card and
 * the same-tag phone notification, so the card stood, and which of three identical clears lost
 * its resolve depended only on iteration order. The rules gate rises; shouldSendResolve alone
 * decides whether a resolve is owed. The boot orphan sweep never consulted the rules either.
 * (v1.187.0 review: nor does either path read `annunciate` now — owedResolveAfterMute.test.ts; the
 * falling edge alone still honours an operator-disabled ISA priority.)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { AlertActionStats } from '../src/alertMonitor.js';
import type { TelemetryEntry } from '../src/alertTelemetry.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-owed-resolve-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '200';
process.env.ALERT_FEED_BUDGET_MS = '1500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { applySilencingRules, autoTuneDispatchVerdict, orphanedNotifiedIds, startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { upsertFamilyMeta } = await import('../src/alertTelemetry.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stats(over: Partial<AlertActionStats>): AlertActionStats {
  return {
    familyKey: 'baseline-mppt_lv_temp', alertId: 'baseline-mppt_lv_temp-COREXXX00XXX0001', title: 'LV MPPT temperature unusual for the hour',
    severity: 'warning', category: 'Thermal',
    riseCount: 0, medianDurationMs: 0, longestDurationMs: 0, shortClearsCount: 0,
    downgradedSilenced: false, warningDemotedToInfo: false, chronicNoiseSilenced: false,
    neverClearedCount: 0, lastSeenAt: null,
    ...over,
  };
}

test('★★★ the 09-29 05:00:10 tick: the family latching Rule 3 mid-tick no longer drops the third resolve', () => {
  // Before the tick: 10 rises, 1 short-clear, 3 long-active (30%). Each clear is retired
  // (recordClear → longActive) before the next same-tick resolve is dispatched.
  const t = stats({ riseCount: 10, shortClearsCount: 1, neverClearedCount: 3 });
  const verdicts: string[] = [];
  for (let i = 0; i < 3; i++) {
    applySilencingRules(t);
    verdicts.push(autoTuneDispatchVerdict(t, { severity: 'warning' }, 'resolved').action);
    t.neverClearedCount++; // retireTrackedAlert → recordClear (a > 4 h episode)
  }
  applySilencingRules(t);
  assert.equal(t.chronicNoiseSilenced, true, 'precondition: Rule 3 did latch during the tick (5/10 → 6/10)');
  assert.deepEqual(verdicts, ['pass', 'pass', 'pass'], 'every owed resolve goes out, in any order');
  // Rises are gated exactly as before.
  const rise = autoTuneDispatchVerdict(t, { severity: 'warning' }, 'new');
  assert.equal(rise.action, 'suppress');
  assert.match(rise.rule ?? '', /Rule 3 \(chronic noise\)/);
});

test('★★ property: no rollup state ever suppresses or demotes a resolve', () => {
  for (const famSev of ['info', 'warning'] as const) {
    for (const alertSev of ['info', 'warning', 'critical'] as const) {
      for (const rises of [0, 5, 12, 160, 400]) {
        for (const shortFrac of [0, 0.75, 1]) {
          for (const neverFrac of [0, 0.1, 0.6]) {
            const t = stats({ familyKey: 'sweep', severity: famSev, riseCount: rises, shortClearsCount: Math.round(rises * shortFrac), neverClearedCount: Math.round(rises * neverFrac) });
            applySilencingRules(t);
            assert.equal(autoTuneDispatchVerdict(t, { severity: alertSev }, 'resolved').action, 'pass', `${famSev}/${alertSev}/${rises}/${shortFrac}/${neverFrac}`);
          }
        }
      }
    }
  }
});

test('the boot orphan sweep resolves an owed record on its own evidence — it reads no rollup, like the falling edge now', () => {
  const persisted = new Map([['baseline-mppt_lv_temp-COREXXX00XXX0005', { ts: Date.now(), sent: true, sev: 'warning' as const }]]);
  const r = orphanedNotifiedIds({
    persisted, currentIds: new Set<string>(), trackedIds: new Set<string>(),
    notifyResolved: true, minSeverity: 'warning', nowMs: 1_000, holdUntilMs: 2_000, unevaluable: () => false,
  });
  assert.deepEqual(r.resolve, ['baseline-mppt_lv_temp-COREXXX00XXX0005']);
});

/* ══ end to end: the real monitor, a family latched in Rule 3 ═══════════════ */

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return { id, severity: 'warning', category: 'Thermal', device: 'System', title: `Owed ${id}`, detail: 'test', source: 'threshold', ...over };
}

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(10);
  }
}

test('★★★ end to end: three pushed alerts of a Rule-3-latched family all get their "Resolved:"; a new rise is still suppressed', { timeout: 20_000 }, async () => {
  // The family's scoped history on disk: 20 rises, 12 long-active — Rule 3 at warning tier.
  const T = Date.now() - 86_400_000;
  const seed: TelemetryEntry[] = [];
  for (let i = 0; i < 20; i++) seed.push({ familyKey: 'owed-fam', alertId: 'owed-fam-COREXXX00XXX0001', event: 'rise', ts: T + i, scope: 'annunciating' });
  for (let i = 0; i < 12; i++) seed.push({ familyKey: 'owed-fam', alertId: 'owed-fam-COREXXX00XXX0001', event: 'longActive', ts: T + 100 + i, durationMs: 5 * 3_600_000, scope: 'annunciating' });
  // v1.187.0 — and the 09-29 LV-MPPT family as it stood: scoped, but counted before the MPPT
  // rule change (no basis). The boot replay must set it aside and SAY what that lifted.
  for (let i = 0; i < 10; i++) seed.push({ familyKey: 'baseline-mppt_lv_temp', alertId: 'baseline-mppt_lv_temp-COREXXX00XXX0005', event: 'rise', ts: T + 200 + i, scope: 'annunciating' });
  for (let i = 0; i < 6; i++) seed.push({ familyKey: 'baseline-mppt_lv_temp', alertId: 'baseline-mppt_lv_temp-COREXXX00XXX0005', event: 'longActive', ts: T + 300 + i, durationMs: 25 * 3_600_000, scope: 'annunciating' });
  appendFileSync(join(tmp, 'alert-telemetry.jsonl'), seed.map((e) => JSON.stringify(e)).join('\n') + '\n');
  upsertFamilyMeta('owed-fam', { title: 'Owed', severity: 'warning', category: 'Thermal', alertId: 'owed-fam-COREXXX00XXX0001' });

  // Three alerts whose rises WERE pushed (by a previous process): each owes a resolve.
  const ids = ['owed-fam-COREXXX00XXX0001', 'owed-fam-COREXXX00XXX0002', 'owed-fam-COREXXX00XXX0005'];
  const freshId = 'owed-fam-COREXXX00XXX0009';
  process.env.NOTIFY_STATE_PATH = join(tmp, 'owed-notify-state.json');
  process.env.DIGEST_STATE_PATH = join(tmp, 'owed-digest.json');
  process.env.CLEARED_LOG_PATH = join(tmp, 'owed-cleared.json');
  writeFileSync(process.env.NOTIFY_STATE_PATH, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { ts: Date.now(), sent: true, sev: 'warning', title: `Owed ${id}` }]))));

  let calls = 0;
  const sent: Array<{ title: string; severity: string }> = [];
  const logs: string[] = [];
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: {
      report: async (n: string) => {
        if (n === 'forecast') return null;
        if (n !== 'curtailmentAlerts') return [];
        calls++;
        if (calls === 1) return ids.map((id) => alert(id));  // standing across the restart
        if (calls === 2) return [];                          // all three clear in ONE tick
        return [alert(freshId)];                             // then a genuinely new rise
      },
    } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; severity: string }) => { sent.push({ title: msg.title, severity: msg.severity }); }) as any,
  });
  try {
    assert.ok(logs.some((l) => /replayed 32 events/.test(l)), 'the latched history was replayed');
    const rebased = logs.find((l) => l.includes('counted under an earlier emitter rule not replayed'));
    assert.ok(rebased, 'the MPPT reset is logged at boot');
    assert.match(rebased!, /^alert-telemetry: 16 event\(s\) of baseline-mppt_lv_temp counted under an earlier emitter rule not replayed/);
    assert.match(rebased!, /Lifted: baseline-mppt_lv_temp \(chronic-noise silence; was 10 rises, 0 short-clears \(0%\), 6 long-active \(60%\); scoped no events yet\)$/);
    assert.equal(mon.telemetry().some((t) => t.familyKey === 'baseline-mppt_lv_temp'), false, 'no latch survives the reset');
    assert.equal(logs.some((l) => /pre-v1\.186\.0 event/.test(l)), false, 'the v1.186.0 line is not misused for it');
    await until(() => sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:')).length >= 3, 8_000, 'three resolves');
    const resolved = sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:')).map((s) => s.title).sort();
    assert.deepEqual(resolved, ids.map((id) => `EcoFlow · Resolved: Owed ${id}`).sort());
    assert.ok(sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:')).every((s) => s.severity === 'resolved'), 'each carries the card dismissal');
    assert.equal(logs.some((l) => /resolve suppressed/.test(l)), false, 'no owed resolve is suppressed');
    // The same latch still gates a new rise, and says so.
    await until(() => logs.some((l) => l.includes(`suppressed "Owed ${freshId}`)), 8_000, 'the new rise to be judged');
    assert.match(logs.find((l) => l.includes(`suppressed "Owed ${freshId}`))!, /auto-tune Rule 3 \(chronic noise\) on family "owed-fam"/);
    assert.equal(sent.some((s) => s.title.includes(freshId)), false, 'the new rise is not pushed');
  } finally {
    mon.stop();
    await sleep(250);
  }
});
