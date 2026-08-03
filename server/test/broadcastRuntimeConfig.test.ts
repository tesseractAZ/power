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
  // `volume` used to be part of the runtime override; it was dropped from
  // BroadcastRuntimeConfig and updateBroadcastRuntimeConfig has ignored it ever
  // since, so passing it was a silent no-op. Behaviour is unchanged by removing it.
  updateBroadcastRuntimeConfig({ enabled: null }, 'test');
}

test('defaults — enabled is null (defer to env baseline)', () => {
  _resetBroadcastRuntimeConfigCacheForTest();
  const c = getBroadcastRuntimeConfig();
  assert.equal(c.enabled, null);
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

test('CRITICAL — BROADCAST_VOLUME reaches the speakers via announceVolume', () => {
  // v1.57.0 — the live slider and its /data override are GONE; BROADCAST_VOLUME
  // is the single source. The property this replaces the old override test with
  // is the one that always mattered: cfg.volume is NEVER sent to a speaker
  // (broadcast.ts) — announceVolume is. If that link breaks, the configured
  // volume becomes silently inert, which is exactly the v0.15.7 defect.
  withEnv({ BROADCAST_ENABLED: 'true', BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: undefined }, () => {
    assert.equal(loadBroadcastConfig().volume, 0.5);
    assert.equal(loadBroadcastConfig().announceVolume, 50, 'announceVolume must derive from BROADCAST_VOLUME');
  });
  withEnv({ BROADCAST_ENABLED: 'true', BROADCAST_VOLUME: '0.9', BROADCAST_ANNOUNCE_VOLUME: undefined }, () => {
    assert.equal(loadBroadcastConfig().announceVolume, 90, 'changing the option changes what speakers get');
  });
});

test('no runtime override can shadow BROADCAST_VOLUME any more', () => {
  // Regression pin for the defect that motivated the removal: the HA form read
  // 0.7 while the speakers played 0.95, with nothing on either surface saying so.
  withEnv({ BROADCAST_ENABLED: 'true', BROADCAST_VOLUME: '0.7', BROADCAST_ANNOUNCE_VOLUME: undefined }, () => {
    updateBroadcastRuntimeConfig({ enabled: true }, 'test');   // the only override left
    assert.equal(loadBroadcastConfig().volume, 0.7, 'volume follows the option, always');
    assert.equal(loadBroadcastConfig().announceVolume, 70);
    clearOverride();
  });
});

test('an env-pinned BROADCAST_ANNOUNCE_VOLUME still pins the announce level (by design)', () => {
  // 'standing' → announceVolume omitted (null) regardless of the volume override.
  withEnv({ BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: 'standing' }, () => {
    updateBroadcastRuntimeConfig({ }, 'test');
    assert.equal(loadBroadcastConfig().announceVolume, null, "'standing' pins announce_volume off");
  });
  // a pinned number wins too.
  withEnv({ BROADCAST_VOLUME: '0.5', BROADCAST_ANNOUNCE_VOLUME: '42' }, () => {
    updateBroadcastRuntimeConfig({ }, 'test');
    assert.equal(loadBroadcastConfig().announceVolume, 42, 'a pinned number wins over the slider');
  });
  clearOverride();
});

test('persistence — override survives a cache reset (re-read from disk)', () => {
  updateBroadcastRuntimeConfig({ enabled: true }, 'test');
  assert.ok(existsSync(process.env.BROADCAST_RUNTIME_CONFIG_PATH!));
  _resetBroadcastRuntimeConfigCacheForTest();
  const c = getBroadcastRuntimeConfig();
  assert.equal(c.enabled, true);
  // sanity: persisted JSON is well-formed
  const onDisk = JSON.parse(readFileSync(process.env.BROADCAST_RUNTIME_CONFIG_PATH!, 'utf8'));
  assert.equal(onDisk.enabled, true);
  clearOverride();
});

test('update notifies listeners synchronously (the closure-coherence mechanism)', () => {
  // broadcast.ts relies on this to refresh its closure cfg the instant a UI
  // toggle lands, so /api/broadcast/config echoes the change without a tick.
  // Collected into an array rather than a `let … = null` sentinel: TypeScript's
  // control-flow analysis cannot see that the listener ran, so it keeps the
  // variable narrowed to `null` and `seen!.enabled` resolves against `never`.
  // An array records the same evidence (fired / did not fire, with the payload)
  // without fighting the narrowing.
  const seen: Array<{ enabled: boolean | null }> = [];
  const off = onBroadcastRuntimeConfigChange((c) => { seen.push(c); });
  updateBroadcastRuntimeConfig({ enabled: true }, 'test');
  assert.equal(seen.length, 1, 'listener fired synchronously on update');
  assert.equal(seen[0].enabled, true);
  off();
  seen.length = 0;
  updateBroadcastRuntimeConfig({ enabled: false }, 'test');
  assert.equal(seen.length, 0, 'unsubscribed listener is not called');
  clearOverride();
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
