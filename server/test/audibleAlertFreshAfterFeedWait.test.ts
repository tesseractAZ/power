/**
 * v1.187.22 — the audible-channel alerts are read when the alert set is ASSEMBLED, not once
 * before the tick's wait on the analytics worker.
 *
 * 2026-10-12: the broadcast monitor's probe restored the audible channel at 22:06:08, yet notify
 * pushed "[Medium] Audible alarm channel unreachable" at 22:06:09 and its "Resolved" at 22:06:29.
 * The alert monitor computed the audible alerts with the live alarms, then awaited the worker
 * feeds (up to ALERT_FEED_BUDGET_MS) and dispatched the set it re-assembled from those same
 * pre-wait values — so a set computed before the restore was pushed after it.
 *
 * Driven through the real monitor (startAlertMonitor) with an injected worker client whose answer
 * lands while the broadcast health changes underneath it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BroadcastHealth } from '../src/broadcastHealth.js';

// The only pending timers may be the monitor's unref'd ones; keep the loop alive for the file.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

// Sidecar paths and knobs are read at import, so they are set first and every app import is dynamic.
const tmp = mkdtempSync(join(tmpdir(), 'ef-am-audible-'));
// Removed once the file is done; retried, as a state write the stopped monitor started can still land.
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
process.env.ALERT_EVAL_MS = '200';
process.env.ALERT_FEED_BUDGET_MS = '1500';
process.env.ALERT_DEBOUNCE_MS = '0';
process.env.NOTIFY_QUIET_HOURS = '';
process.env.NOTIFY_STATE_PATH = join(tmp, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(tmp, 'digest.json');
process.env.CLEARED_LOG_PATH = join(tmp, 'cleared.json');
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;

// v1.191.0 — imported after the environment is set: the stub's import chain now reaches config.ts
// (aggregator.ts → siteTime.ts), which reads DB_PATH once when it loads.
const { makeRecorderStub } = await import('./helpers/recorderStub.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const H = await import('../src/broadcastHealth.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(5);
  }
}

const HEALTHY: BroadcastHealth = {
  enabled: true, supervised: true, targetCount: 2, usableTargets: 2, musicAssistantAvailable: true,
  reachable: true, reason: null, lastProbeAt: 1, degraded: false, unusableTargets: [],
};
const DEAD: BroadcastHealth = {
  ...HEALTHY, usableTargets: 0, musicAssistantAvailable: false, reachable: false, degraded: true,
  reason: 'configured speaker(s) not found in Home Assistant', unusableTargets: ['media_player.a (not found or unreadable)', 'media_player.b (not found or unreadable)'],
};
const UNREACHABLE_TITLE = 'Audible alarm channel unreachable';

test('★★★ a channel restored during the worker wait is not pushed as unreachable (2026-10-12 22:06:08/09)', { timeout: 20_000 }, async () => {
  H.setBroadcastHealth(HEALTHY);
  const sent: string[] = [];
  let restoreDuringWait = false;
  const store = new SnapshotStore();
  store.markFirstPollSettled();
  const logs: string[] = [];
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => logs.push(m), {
    analytics: {
      report: async (n: string) => {
        if (n === 'baselineAlerts' && restoreDuringWait) {
          restoreDuringWait = false;
          await sleep(40); // the worker answers well inside its budget…
          H.setBroadcastHealth(HEALTHY); // …and a probe restores the channel meanwhile
        }
        return n === 'forecast' ? null : [];
      },
    } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: async (_cfg: unknown, msg: { title: string }) => { sent.push(msg.title); },
  });
  try {
    await until(() => mon.stats().evalPasses >= 1, 5_000, 'the first (boot-seeded) pass');
    // The channel is confirmed dead: the next pass tracks the alert (a rising edge, no push yet).
    H.setBroadcastHealth(DEAD);
    await until(() => mon.activeAlertIds().includes(H.AUDIBLE_UNREACHABLE_ALERT_ID), 5_000, 'the unreachable alert tracked');
    // The pass that would push it computes its live alarms with the channel still dead, then
    // waits on the worker, during which the channel is restored.
    restoreDuringWait = true;
    const passes = mon.stats().evalPasses;
    await until(() => mon.stats().evalPasses >= passes + 3, 5_000, 'three more passes');
    assert.equal(restoreDuringWait, false, 'the restore ran inside a pass');
    assert.deepEqual(sent.filter((t) => t.includes(UNREACHABLE_TITLE)), [],
      'neither the stale "unreachable" push nor its "Resolved" a pass later');
    assert.equal(mon.activeAlertIds().includes(H.AUDIBLE_UNREACHABLE_ALERT_ID), false);

    // Control: a channel that stays dead is still pushed — the fresh read suppresses nothing real.
    H.setBroadcastHealth(DEAD);
    await until(() => sent.some((t) => t.includes(UNREACHABLE_TITLE)), 5_000, 'the push for a channel that stays dead');
    assert.equal(sent.filter((t) => t.includes(UNREACHABLE_TITLE)).length, 1);
    assert.ok(!sent.some((t) => t.startsWith('Power · Resolved:')), sent.join('\n'));
  } finally {
    mon.stop();
    H.resetBroadcastHealth();
    await sleep(250);
  }
});
