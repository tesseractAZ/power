/**
 * v1.187.3 — a push auto-tuned down to "[Low]" still owes its "Resolved:".
 *
 * v1.88.0 recorded the tier the operator saw (`notifiedEffectiveSeverity`) and shouldSendResolve
 * qualified THAT against the minimum severity, so a fire delivered as "[Low] … via auto-tune" owed
 * no resolve. But the resolve is the only thing that dismisses the Home Assistant drawer card and
 * replaces the same-tag phone notification (notify.ts: a 'resolved' message becomes
 * persistent_notification.dismiss). On 2026-10-01 a "[Low] Cell-voltage spread — peer outlier"
 * pushed at 13:16:09 (Rule 2 on peer-voldiff) cleared at 13:26:29, and its drawer card was still
 * standing at 19:11 — a cleared condition shown as active. The boot orphan sweep always resolved
 * such a fire (its record keeps the source severity); the falling edge now agrees.
 *
 * Kept: an ISA priority turned off in Alert Settings since the push still suppresses the resolve
 * (dispatch), and a fire that was never pushed owes nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert } from '../src/alerts.js';
import type { TelemetryEntry } from '../src/alertTelemetry.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

// The monitor's only pending timers are unref'd; Node 22's runner would otherwise end the
// event loop mid-test and cancel the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const tmp = mkdtempSync(join(tmpdir(), 'ef-demoted-resolve-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '100';
process.env.ALERT_FEED_BUDGET_MS = '500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_MIN_SEVERITY = 'warning';
process.env.ALERT_TELEMETRY_PATH = join(tmp, 'alert-telemetry.jsonl');
process.env.ALERT_FAMILY_META_PATH = join(tmp, 'alert-family-meta.json');
process.env.ALERT_SETTINGS_PATH = join(tmp, 'alert-settings.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NOTIFY_RESOLVED;

const FAM_A = 'noisy-a';
const FAM_B = 'noisy-b';
const T = Date.now() - 3_600_000;
/** Each family's rollup: 10 rises, 9 short-clears (90%) — Rule 2 demotes a warning push to [Low]. */
const seed: TelemetryEntry[] = [];
for (const fam of [FAM_A, FAM_B]) {
  for (let i = 0; i < 10; i++) {
    seed.push({ familyKey: fam, alertId: `${fam}-COREXXX00XXX0001`, event: 'rise', ts: T + i * 1000, scope: 'annunciating' });
    if (i < 9) seed.push({ familyKey: fam, alertId: `${fam}-COREXXX00XXX0001`, event: 'shortClear', ts: T + i * 1000 + 500, durationMs: 240_000, scope: 'annunciating' });
  }
}
writeFileSync(process.env.ALERT_TELEMETRY_PATH, seed.map((e) => JSON.stringify(e)).join('\n') + '\n');

const { shouldSendResolve, startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { upsertFamilyMeta } = await import('../src/alertTelemetry.js');
const { updateAlertSettings } = await import('../src/alertSettings.js');

for (const fam of [FAM_A, FAM_B]) {
  upsertFamilyMeta(fam, { title: 'Noisy', severity: 'warning', category: 'Battery', alertId: `${fam}-COREXXX00XXX0001` });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string, logs: string[]): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}\n${logs.slice(-30).join('\n')}`);
    await sleep(10);
  }
}

/** Boot a monitor whose feed raises `id` (a threshold warning on Core 5) after the first pass,
 *  then clears it. `afterPush` runs between the push and the clear. */
async function demotedEpisode(fam: string, afterPush: () => void = () => {}) {
  const id = `${fam}-COREXXX00XXX0005`;
  process.env.NOTIFY_STATE_PATH = join(tmp, `${fam}-notify-state.json`);
  process.env.DIGEST_STATE_PATH = join(tmp, `${fam}-digest.json`);
  process.env.CLEARED_LOG_PATH = join(tmp, `${fam}-cleared.json`);
  let phase: 'boot' | 'hot' | 'cleared' = 'boot';
  const alert: Alert = {
    id, severity: 'warning', source: 'threshold', category: 'Battery', device: 'Core 5', coreNum: 5,
    title: `Noisy ${fam}`, detail: 'test',
  } as Alert;
  const sent: Array<{ title: string; severity: string }> = [];
  const logs: string[] = [];
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: {
      report: async (n: string) => (n === 'forecast' ? null : n === 'curtailmentAlerts' && phase === 'hot' ? [alert] : []),
    } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async (_cfg: unknown, msg: { title: string; severity: string }) => { sent.push({ title: msg.title, severity: msg.severity }); }) as any,
  });
  try {
    const at = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= at + 2, 5_000, 'the boot passes', logs);
    phase = 'hot';
    await until(() => sent.length >= 1, 5_000, 'the push', logs);
    afterPush();
    phase = 'cleared';
    await until(() => !mon.activeAlertIds().includes(id), 5_000, 'the clear', logs);
    const done = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= done + 3, 5_000, 'three more passes for a resolve', logs);
    return { sent, logs, id };
  } finally {
    mon.stop();
    await sleep(200);
  }
}

test('★★★ 10-01 13:16: a push demoted to [Low] by auto-tune Rule 2 gets its "Resolved:" (the card dismissal) when it clears', { timeout: 20_000 }, async () => {
  const { sent, logs } = await demotedEpisode(FAM_A);
  assert.equal(sent.length, 2, JSON.stringify(sent));
  assert.equal(sent[0].title, `EcoFlow · [Low] Noisy ${FAM_A} — Core 5`);
  assert.equal(sent[0].severity, 'info', 'delivered at the demoted tier');
  assert.ok(logs.some((l) => l.includes(`(severity warning→info via auto-tune — Rule 2 (warning short-clears) on family "${FAM_A}"`)), 'the demotion is the precondition');
  assert.equal(sent[1].title, `EcoFlow · Resolved: Noisy ${FAM_A} — Core 5`);
  assert.equal(sent[1].severity, 'resolved', 'the resolve carries persistent_notification.dismiss and the same-tag replacement');
});

test('★★★ the priority-disabled exception is kept: a [Low] push whose ISA priority is turned off before it clears is not resolved', { timeout: 20_000 }, async () => {
  try {
    const { sent, logs } = await demotedEpisode(FAM_B, () => { updateAlertSettings({ priorityEnabled: { high: false } }, 'test'); });
    assert.equal(sent.length, 1, JSON.stringify(sent));
    assert.match(sent[0].title, /^EcoFlow · \[Low\] /);
    assert.ok(logs.some((l) => l.includes(`resolve suppressed "Noisy ${FAM_B} — Core 5" (warning) — its priority (High) is turned off in Alert Settings`)));
  } finally {
    updateAlertSettings({ priorityEnabled: { high: true } }, 'test');
  }
});

test('the pure gate: the dispatched severity decides, whatever tier auto-tune showed', () => {
  const a = { id: `${FAM_A}-COREXXX00XXX0005`, severity: 'warning' as const };
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', alert: a }, true, 'warning'), true);
  assert.equal(shouldSendResolve({ pushSent: false, notifiedSeverity: 'warning', alert: a }, true, 'warning'), false, 'never pushed: nothing to dismiss');
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'info', alert: a }, true, 'warning'), false, 'an info push (minimum lowered, then raised) is not resolved, as before');
});
