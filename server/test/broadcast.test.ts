import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionFromAlerts, loadBroadcastConfig } from '../src/broadcast.js';
import { generateAudioAssets } from '../src/audioAssets.js';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * v0.9.18 — broadcast tests.
 *
 * The networked side (callHaService / monitor / tick loop) is tested
 * manually via /api/broadcast/test against a real HA instance. These
 * unit tests cover the parts we CAN exercise in isolation:
 *
 *   - conditionFromAlerts: severity → condition-level mapping
 *   - loadBroadcastConfig: env-var parsing + defaults
 *   - generateAudioAssets: WAV-file synthesis produces well-formed RIFF
 */

test('conditionFromAlerts — empty list → green', () => {
  const r = conditionFromAlerts([]);
  assert.equal(r.level, 'green');
  assert.equal(r.crit, 0);
  assert.equal(r.warn, 0);
});

test('conditionFromAlerts — warning-only → yellow', () => {
  const r = conditionFromAlerts([
    { id: 'a', severity: 'warning', category: 'Battery', device: 'core 1', title: 't', detail: 'd' },
  ] as any);
  assert.equal(r.level, 'yellow');
  assert.equal(r.warn, 1);
});

test('conditionFromAlerts — any critical → red (regardless of warnings)', () => {
  const r = conditionFromAlerts([
    { id: 'a', severity: 'warning', category: 'Battery', device: 'core 1', title: 't', detail: 'd' },
    { id: 'b', severity: 'critical', category: 'Thermal', device: 'core 2', title: 't', detail: 'd' },
  ] as any);
  assert.equal(r.level, 'red');
  assert.equal(r.crit, 1);
  assert.equal(r.warn, 1);
});

test('loadBroadcastConfig — defaults are safe (disabled, no targets)', () => {
  // Clear any env in the test context.
  const prev = { ...process.env };
  delete process.env.BROADCAST_ENABLED;
  delete process.env.BROADCAST_TARGETS;
  delete process.env.BROADCAST_VOLUME;
  delete process.env.BROADCAST_MIN_SEVERITY;
  delete process.env.BROADCAST_WYOMING_HOST;
  delete process.env.BROADCAST_WYOMING_PORT;
  delete process.env.BROADCAST_WYOMING_VOICE;
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.targets.length, 0);
    assert.equal(cfg.minSeverity, 'critical');
    assert.ok(cfg.volume >= 0 && cfg.volume <= 1);
    // v0.9.70 — Wyoming defaults: in-cluster hostname + standard port,
    // no voice override (Piper add-on's configured default is used).
    assert.equal(cfg.wyomingHost, 'core-piper');
    assert.equal(cfg.wyomingPort, 10200);
    assert.equal(cfg.wyomingVoice, null);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — v0.9.70 Wyoming env overrides take effect', () => {
  const prev = { ...process.env };
  try {
    process.env.BROADCAST_WYOMING_HOST = '192.168.1.50';
    process.env.BROADCAST_WYOMING_PORT = '10201';
    process.env.BROADCAST_WYOMING_VOICE = 'en_US-amy-medium';
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.wyomingHost, '192.168.1.50');
    assert.equal(cfg.wyomingPort, 10201);
    assert.equal(cfg.wyomingVoice, 'en_US-amy-medium');
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — invalid wyoming port falls back to 10200', () => {
  const prev = { ...process.env };
  try {
    process.env.BROADCAST_WYOMING_PORT = 'not-a-number';
    assert.equal(loadBroadcastConfig().wyomingPort, 10200);
    process.env.BROADCAST_WYOMING_PORT = '';
    assert.equal(loadBroadcastConfig().wyomingPort, 10200);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — parses targets, ignores non-media_player IDs', () => {
  const prev = { ...process.env };
  process.env.BROADCAST_TARGETS = 'media_player.living_room, sensor.bogus, media_player.kitchen';
  process.env.BROADCAST_ENABLED = 'true';
  process.env.BROADCAST_VOLUME = '0.7';
  try {
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.targets, ['media_player.living_room', 'media_player.kitchen']);
    assert.equal(cfg.volume, 0.7);
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — clamps volume to [0, 1]', () => {
  const prev = { ...process.env };
  process.env.BROADCAST_VOLUME = '1.5';
  try {
    let cfg = loadBroadcastConfig();
    assert.equal(cfg.volume, 1);
    process.env.BROADCAST_VOLUME = '-0.5';
    cfg = loadBroadcastConfig();
    assert.equal(cfg.volume, 0);
  } finally {
    process.env = prev;
  }
});

test('generateAudioAssets — writes all four WAVs with valid RIFF header', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'audio-test-'));
  try {
    await generateAudioAssets(dir, () => {});
    for (const id of ['red-alert', 'yellow-alert', 'all-clear', 'boatswain']) {
      const path = resolve(dir, `${id}.wav`);
      assert.ok(existsSync(path), `${id}.wav was not written`);
      const buf = readFileSync(path);
      assert.ok(buf.length > 1000, `${id}.wav suspiciously small`);
      // RIFF header check
      assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
      assert.equal(buf.subarray(8, 12).toString(), 'WAVE');
      assert.equal(buf.subarray(12, 16).toString(), 'fmt ');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateAudioAssets — idempotent (does not re-write existing files)', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'audio-test-'));
  try {
    await generateAudioAssets(dir, () => {});
    const before = readFileSync(resolve(dir, 'red-alert.wav'));
    // Re-run — should be no-op.
    await generateAudioAssets(dir, () => {});
    const after = readFileSync(resolve(dir, 'red-alert.wav'));
    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
