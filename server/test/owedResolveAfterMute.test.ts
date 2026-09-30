/**
 * v1.187.0 review — a mute AFTER the push does not cancel the "Resolved:" that push is owed.
 *
 * shouldSendResolve required `annunciate !== false` on the alert's last present tick. Since
 * v0.80.0 the gate is `pushSent` (a delivered push, or a notify-state record that says one was),
 * which already excludes the never-pushed spare that term was added for (v0.16.4). What it still
 * did was drop the resolve of a card the operator HAD been sent, whenever the alert was muted
 * before it cleared — the general-2 harm (an HA drawer card and a same-tag phone notification
 * left standing) through a different gate. v1.187.0 makes MPPT alerts go quiet mid-episode:
 *   (a) a "[Medium] LV MPPT temperature unusual" pushed under v1.186.5 and still active at the
 *       deploy is re-tracked from its record, but the new rule calls it `cooler` (annunciate:false);
 *   (b) a hot `anomalous` warning is pushed, then the Core starts a night charge and the same id
 *       turns `load-explained` (annunciate:false) before it clears.
 * Both now get their "Resolved:"; a never-pushed muted alert still gets none.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-owed-after-mute-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const { shouldSendResolve, startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(10);
  }
}

const COOLER = 'cooler than typical, not a hazard';
const EXPLAINED = "heat explained by the Core's load";

/* ── the pure gate ───────────────────────────────────────────────────────── */

test('★★★ shouldSendResolve: a pushed MPPT warning muted before it clears still owes its resolve', () => {
  const lv = (over: Partial<Alert>) => ({ id: 'baseline-mppt_lv_temp-COREXXX00XXX0005', severity: 'info' as const, annunciate: false, muteReason: COOLER, ...over });
  // (a) re-tracked at boot from a sent:true record, now a cooler (on-screen only) reading.
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', alert: lv({}) }, true, 'warning'), true);
  // (b) pushed as anomalous, then load-explained.
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', notifiedEffectiveSeverity: 'warning', alert: lv({ muteReason: EXPLAINED }) }, true, 'warning'), true);
  // Never pushed (a bench spare's, a cooler reading from its first tick): nothing to dismiss.
  assert.equal(shouldSendResolve({ pushSent: false, notifiedSeverity: 'warning', alert: lv({}) }, true, 'warning'), false);
  assert.equal(shouldSendResolve({ notifiedSeverity: 'warning', alert: lv({}) }, true, 'warning'), false);
  // The other gates are unchanged: a push auto-tuned to [Low] owes nothing; resolves can be off.
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', notifiedEffectiveSeverity: 'info', alert: lv({}) }, true, 'warning'), false);
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', alert: lv({}) }, false, 'warning'), false);
});

/* ── end to end: the real monitor ───────────────────────────────────────── */

test('★★★ end to end: (a) re-tracked muted, (b) pushed then muted — both dismissed on clear; a never-pushed muted alert is not', { timeout: 20_000 }, async () => {
  // Non-learned source so the 10-minute learned warm-up grace does not hold the falling edge;
  // the gate under test reads neither the source nor the family.
  const mk = (id: string, over: Partial<Alert> = {}): Alert => ({
    id, severity: 'warning', category: 'Thermal', device: 'System', title: `MPPT ${id}`, detail: 'test', source: 'threshold', ...over,
  });
  const A = 'mute-a-COREXXX00XXX0005'; // pushed by the previous process; muted from this boot
  const B = 'mute-b-COREXXX00XXX0006'; // pushed in this process; muted before it clears
  const C = 'mute-c-COREXXX00XXX0008'; // muted from its first tick; never pushed
  writeFileSync(process.env.NOTIFY_STATE_PATH!, JSON.stringify({ [A]: { ts: Date.now(), sent: true, sev: 'warning', title: `MPPT ${A}` } }));
  let phase: 'boot' | 'b-hot' | 'b-muted' | 'cleared' = 'boot';
  const sent: Array<{ title: string; severity: string }> = [];
  const logs: string[] = [];
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: {
      report: async (n: string) => {
        if (n === 'forecast') return null;
        if (n !== 'curtailmentAlerts') return [];
        const a = mk(A, { severity: 'info', annunciate: false, muteReason: COOLER });
        const c = mk(C, { annunciate: false, muteReason: EXPLAINED });
        if (phase === 'boot') return [a, c];
        if (phase === 'b-hot') return [a, c, mk(B)];
        if (phase === 'b-muted') return [a, c, mk(B, { severity: 'info', annunciate: false, muteReason: EXPLAINED })];
        return [];
      },
    } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; severity: string }) => { sent.push({ title: msg.title, severity: msg.severity }); }) as any,
  });
  const onScreen = (id: string) => (store.get().alerts ?? []).find((x) => x.id === id);
  try {
    await until(() => mon.activeAlertIds().includes(A) && mon.activeAlertIds().includes(C), 5_000, 'A re-tracked, C tracked');
    phase = 'b-hot';
    // (source 'threshold' pushes as [High]; a learned MPPT alert pushes as [Medium] — the tier is not under test)
    await until(() => sent.some((s) => s.severity === 'warning' && /^EcoFlow · \[\w+\] /.test(s.title) && s.title.endsWith(`MPPT ${B}`)), 5_000, 'B pushed as a warning');
    phase = 'b-muted';
    await until(() => onScreen(B)?.annunciate === false, 5_000, 'B muted on screen');
    const passes = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= passes + 2, 5_000, 'B tracked muted for a tick');
    phase = 'cleared';
    await until(() => sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:')).length >= 2, 5_000, 'two resolves');
    const done = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= done + 3, 5_000, 'three more ticks for any stray resolve');
    const resolved = sent.filter((s) => s.title.startsWith('EcoFlow · Resolved:'));
    assert.deepEqual(resolved.map((s) => s.title).sort(), [`EcoFlow · Resolved: MPPT ${A}`, `EcoFlow · Resolved: MPPT ${B}`]);
    assert.ok(resolved.every((s) => s.severity === 'resolved'), 'each carries the card dismissal');
    assert.equal(sent.some((s) => s.title.includes(`MPPT ${C}`)), false, 'the never-pushed muted alert: no push, no resolve');
    assert.equal(sent.some((s) => s.severity !== 'resolved' && s.title.endsWith(`MPPT ${A}`)), false, 'A was not re-pushed across the restart');
  } finally {
    mon.stop();
    await sleep(200);
  }
});
