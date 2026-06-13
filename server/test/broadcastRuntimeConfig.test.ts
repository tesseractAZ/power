import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/* ===================================================================
 * v0.18.0 — runtime broadcast config (live enable + volume).
 *
 * Pins: (1) the /data override mirrors alertSettings (set / clear /
 * persist / clamp); (2) the override MERGES correctly into
 * loadBroadcastConfig and — the critical part the recon flagged — the
 * volume override flows into announceVolume (the value actually sent to
 * the speakers), not just cfg.volume; (3) an env-pinned
 * BROADCAST_ANNOUNCE_VOLUME still wins over the slider, by design.
 * =================================================================== */

const tmp = mkdtempSync(resolve(tmpdir(), 'bcastcfg-test-'));
process.env.BROADCAST_RUNTIME_CONFIG_PATH = resolve(tmp, 'broadcast-runtime-config.json');

const {
  getBroadcastRuntimeConfig, updateBroadcastRuntimeConfig, onBroadcastRuntimeConfigChange,
  _resetBroadcastRuntimeConfigCacheForTest,
} = await import('../src/broadcastRuntimeConfig.js');
const { loadBroadcastConfig } = await import('../src/broadcast.js');

/** Run `fn` with a controlled broadcast env, restoring the prior env after. */
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const keys = ['BROADCAST_ENABLED', 'BROADCAST_VOLUME', 'BROADCAST_ANNOUNCE_VOLUME'];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    fn();
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

function clearOverride() {
  updateBroadcastRuntimeConfig({ enabled: null, volume: null }, 'test');
}

test('defaults — both fields null (defer to env baseline)', () => {
  _resetBroadcastRuntimeConfigCacheForTest();
  const c = getBroadcastRuntimeConfig();
  assert.equal(c.enabled, null);
  assert.equal(c.volume, null);
});

test('loadBroadcastConfig — uses env baseline when no override is set', () => {
  clearOverride();
  withEnv({ BROADCAST_ENABLED: 'true', BROADCAST_VOLUME: '0.6', BROADCAST_ANNOUNCE_VOLUME: undefined }, () => {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.volume, 0.6);
    assert.equal(cfg.announceVolume, 60); // volume*100 when ANNOUNCE_VOLUME blank
  });
});

test('loadBroadcastConfig — enable override wins over env', () => {
  withEnv({ BROADCAST_ENABLED: 'false', BROADCAST_VOLUME: '0.5' }, () => {
    updateBroadcastRuntimeConfig({ enabled: true }, 'test');
    assert.equal(loadBroadcastConfig().enabled, true, 'override true beats env false');
    updateBroadcastRuntimeConfig({ enabled: false }, 'test');
    assert.equal(loadBroadcastConfig().enabled, false, 'override false beats env (none/false)');
    clearOverride();
    assert.equal(loadBroadcastConfig().enabled, false, 'cleared → env false');
  });
});

test('CRITICAL — volume override flows into announceVolume, not just cfg.volume', () => {
  withEnv({ BROADCAST_ENABLED: 'true', BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: undefined }, () => {
    updateBroadcastRuntimeConfig({ volume: 0.9 }, 'test');
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.volume, 0.9);
    assert.equal(cfg.announceVolume, 90, 'announceVolume must track the override (90), not the env 50');
    clearOverride();
    assert.equal(loadBroadcastConfig().announceVolume, 50, 'cleared → env-derived 50');
  });
});

test('volume override is clamped to [0,1]', () => {
  withEnv({ BROADCAST_VOLUME: '0.5' }, () => {
    updateBroadcastRuntimeConfig({ volume: 1.5 }, 'test');
    assert.equal(loadBroadcastConfig().volume, 1);
    updateBroadcastRuntimeConfig({ volume: -0.3 }, 'test');
    assert.equal(loadBroadcastConfig().volume, 0);
    clearOverride();
  });
});

test('an env-pinned BROADCAST_ANNOUNCE_VOLUME still wins over the slider (by design)', () => {
  // 'standing' → announceVolume omitted (null) regardless of the volume override.
  withEnv({ BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: 'standing' }, () => {
    updateBroadcastRuntimeConfig({ volume: 0.9 }, 'test');
    assert.equal(loadBroadcastConfig().announceVolume, null, "'standing' pins announce_volume off");
  });
  // a pinned number wins too.
  withEnv({ BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: '42' }, () => {
    updateBroadcastRuntimeConfig({ volume: 0.9 }, 'test');
    assert.equal(loadBroadcastConfig().announceVolume, 42, 'a pinned number wins over the slider');
  });
  clearOverride();
});

test('persistence — override survives a cache reset (re-read from disk)', () => {
  updateBroadcastRuntimeConfig({ enabled: true, volume: 0.7 }, 'test');
  assert.ok(existsSync(process.env.BROADCAST_RUNTIME_CONFIG_PATH!));
  _resetBroadcastRuntimeConfigCacheForTest();
  const c = getBroadcastRuntimeConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.volume, 0.7);
  // sanity: persisted JSON is well-formed
  const onDisk = JSON.parse(readFileSync(process.env.BROADCAST_RUNTIME_CONFIG_PATH!, 'utf8'));
  assert.equal(onDisk.enabled, true);
  assert.equal(onDisk.volume, 0.7);
  clearOverride();
});

test('update notifies listeners synchronously (the closure-coherence mechanism)', () => {
  // broadcast.ts relies on this to refresh its closure cfg the instant a UI
  // toggle lands, so /api/broadcast/config echoes the change without a tick.
  let seen: { enabled: boolean | null; volume: number | null } | null = null;
  const off = onBroadcastRuntimeConfigChange((c) => { seen = c; });
  updateBroadcastRuntimeConfig({ enabled: true, volume: 0.4 }, 'test');
  assert.ok(seen, 'listener fired synchronously on update');
  assert.equal(seen!.enabled, true);
  assert.equal(seen!.volume, 0.4);
  off();
  seen = null;
  updateBroadcastRuntimeConfig({ enabled: false }, 'test');
  assert.equal(seen, null, 'unsubscribed listener is not called');
  clearOverride();
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
