/**
 * v1.187.10 — "Audible Alarm Channel" reads unknown, not disabled, before the first speaker probe.
 *
 * The pre-probe BroadcastHealth default has `enabled: false` only because nothing has been read
 * yet, and the published status tested `enabled` first. The first state publish lands ~5 s after
 * broker connect, the first probe ~15 s after broadcast init, and the probe triggers no republish,
 * so every restart published "disabled" for one 30 s cycle on a channel configured on (HA history
 * 2026-10-02 17:53:16 and 19:24:00, 2026-10-03 12:08:13). An automation keyed on "disabled" would
 * fire at every deploy. The sibling speaker count already read unknown (publish readiness).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsClient } from '../src/analyticsClient.js';
import type { FleetSnapshot, SnapshotStore } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'audible-status-boot-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
process.env.MQTT_DISCOVERY_ENABLED = '1';
process.env.MQTT_DISCOVERY_HOST = '127.0.0.1';
process.env.MQTT_DISCOVERY_PORT = '9';

const { audibleStatus, getBroadcastHealth, resetBroadcastHealth, setBroadcastHealth } = await import('../src/broadcastHealth.js');
const mqttDiscovery = await import('../src/mqttDiscovery.js');
const { setAnalyticsClientForTesting } = await import('../src/analyticsClient.js');

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const probed = (over: Partial<ReturnType<typeof getBroadcastHealth>>) => ({
  enabled: true, supervised: true, targetCount: 2, usableTargets: 2, musicAssistantAvailable: true,
  reachable: true as boolean | null, reason: null, lastProbeAt: Date.now(), ...over,
});

test('★★★ before the first probe the status is unknown — the pre-probe default is not "disabled"', () => {
  resetBroadcastHealth();
  const h = getBroadcastHealth();
  assert.equal(h.enabled, false, 'precondition: the default carries enabled:false');
  assert.equal(h.lastProbeAt, null);
  assert.equal(audibleStatus(h), 'unknown');
});

test('★★ once probed, the four states keep their meaning', () => {
  assert.equal(audibleStatus(probed({})), 'reachable');
  assert.equal(audibleStatus(probed({ enabled: false, reachable: null })), 'disabled', 'the operator chose silence');
  assert.equal(audibleStatus(probed({ reachable: false, usableTargets: 0 })), 'UNREACHABLE');
  assert.equal(audibleStatus(probed({ reachable: null })), 'unknown', 'probed but not yet confirmed either way');
  assert.equal(audibleStatus(probed({ supervised: false, reachable: null })), 'unknown', 'unsupervised: not applicable');
});

function stubAnalytics(): AnalyticsClient {
  return {
    report: async <T = any>(): Promise<T> => null as T,
    query: async () => [], listMetrics: async () => [], pushSnapshot: () => {}, flushSnapshot: () => {},
    pushOwnerFloor: () => {}, stop: () => {},
  };
}

test('★★★ buildState: the publish before the first probe carries audible_status "unknown" beside a null speaker count', async () => {
  resetBroadcastHealth();
  setAnalyticsClientForTesting(stubAnalytics());
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {} };
  const store = { get: () => snap, on: () => {} } as unknown as SnapshotStore;
  const handle = await mqttDiscovery.startMqttDiscovery(store, makeRecorderStub(), () => {});
  try {
    const boot = await handle.buildState!(snap);
    assert.equal(boot.audible_status, 'unknown');
    assert.equal(boot.audible_usable_speakers, null);
    setBroadcastHealth(probed({}));
    const after = await handle.buildState!(snap);
    assert.equal(after.audible_status, 'reachable');
    assert.equal(after.audible_usable_speakers, 2);
    setBroadcastHealth(probed({ enabled: false, reachable: null, usableTargets: 0 }));
    assert.equal((await handle.buildState!(snap)).audible_status, 'disabled', 'a probed disabled channel still says so');
  } finally {
    handle.stop();
    setAnalyticsClientForTesting(null);
    resetBroadcastHealth();
  }
});
