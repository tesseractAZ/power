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

test('conditionFromAlerts — v0.16.4: annunciate:false alerts do NOT raise the condition', () => {
  // An expected-offline bench spare is emitted with annunciate:false. It must
  // stay out of the crit/warn counts so it can never trigger a chime/broadcast,
  // while a genuine (annunciating) warning alongside it still raises the level.
  const muted = conditionFromAlerts([
    { id: 'offline-SPARE', severity: 'warning', category: 'Connectivity', device: 'Core 4', title: 't', detail: 'd', annunciate: false },
  ] as any);
  assert.equal(muted.level, 'green', 'a non-annunciating warning must not turn the condition yellow');
  assert.equal(muted.warn, 0);

  const mixed = conditionFromAlerts([
    { id: 'offline-SPARE', severity: 'warning', category: 'Connectivity', device: 'Core 4', title: 't', detail: 'd', annunciate: false },
    { id: 'offline-CORE1', severity: 'warning', category: 'Connectivity', device: 'Core 1', title: 't', detail: 'd' },
  ] as any);
  assert.equal(mixed.level, 'yellow', 'a real annunciating warning still raises the condition');
  assert.equal(mixed.warn, 1, 'only the annunciating alert is counted');
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

test('loadBroadcastConfig — SCOPE GUARD: only well-formed media_player.* targets survive', () => {
  // The audible-broadcast scope guarantee: a notice may ONLY play on the
  // entities listed in BROADCAST_TARGETS. Parsing drops blanks, whitespace,
  // and anything not prefixed `media_player.` — so a typo or an injected
  // non-media_player entity can never become a broadcast endpoint.
  const prev = { ...process.env };
  try {
    process.env.BROADCAST_TARGETS =
      ' media_player.kitchen , , media_player.master_homepod ,switch.pool_pump, light.porch ,, media_player.guest_thermostat ';
    const cfg = loadBroadcastConfig();
    assert.deepEqual(cfg.targets, [
      'media_player.kitchen',
      'media_player.master_homepod',
      'media_player.guest_thermostat',
    ], 'only trimmed media_player.* entries are admitted — no out-of-scope endpoints');
    assert.ok(!cfg.targets.some((t) => !t.startsWith('media_player.')), 'no non-media_player target can leak in');
  } finally {
    process.env = prev;
  }
});

test('loadBroadcastConfig — SCOPE GUARD: garbage/empty BROADCAST_TARGETS yields zero targets (never a wildcard)', () => {
  const prev = { ...process.env };
  try {
    for (const raw of ['', '   ', ',,,', 'all', 'media_player', 'kitchen', 'group.all_speakers']) {
      process.env.BROADCAST_TARGETS = raw;
      const cfg = loadBroadcastConfig();
      assert.equal(cfg.targets.length, 0, `"${raw}" must produce NO targets, not a fan-out`);
    }
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

/* ===================================================================
 * v0.9.80 — probeService three-state probe. The startup race produced a
 * false "music_assistant.play_announcement NOT detected — broadcasts
 * will fail" line because hasService() collapsed a FAILED catalog fetch
 * (Core not ready at boot) into the same `false` as "service genuinely
 * absent". probeService distinguishes them: a failed fetch is 'unknown',
 * never 'absent'. With no SUPERVISOR_TOKEN the catalog fetch returns null
 * → must be 'unknown', proving a transient failure is never reported as a
 * confirmed missing service.
 * =================================================================== */
import { probeService } from '../src/haService.js';

test('probeService — failed catalog fetch yields "unknown", not "absent"', async () => {
  const prev = process.env.SUPERVISOR_TOKEN;
  delete process.env.SUPERVISOR_TOKEN;
  try {
    const r = await probeService('music_assistant', 'play_announcement');
    assert.equal(r, 'unknown', 'a failed/early catalog fetch must be unknown, never a confirmed absent');
  } finally {
    if (prev === undefined) delete process.env.SUPERVISOR_TOKEN;
    else process.env.SUPERVISOR_TOKEN = prev;
  }
});

/* ===================================================================
 * v0.15.4 — ecobee announcement reliability knobs. The ecobee thermostat
 * speakers drop Music Assistant's set-volume→play→restore dance, so we add
 * four config levers: BROADCAST_REPEAT (play the chime+TTS block twice so a
 * missed first annunciation is caught), BROADCAST_ANNOUNCE_VOLUME ("off"
 * omits announce_volume entirely → MA plays at the device's standing volume,
 * skipping the flaky volume restore), BROADCAST_USE_PRE_ANNOUNCE, and
 * BROADCAST_ANNOUNCE_RETRIES. This pins their parse + clamp + fallback rules.
 * =================================================================== */
test('loadBroadcastConfig — v0.15.4 repeat / announce-volume / pre-announce / retries', () => {
  const saved = { ...process.env };
  try {
    process.env.BROADCAST_REPEAT = '2';
    process.env.BROADCAST_ANNOUNCE_VOLUME = 'off';
    process.env.BROADCAST_USE_PRE_ANNOUNCE = 'true';
    process.env.BROADCAST_ANNOUNCE_RETRIES = '2';
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.repeat, 2);
    assert.equal(cfg.announceVolume, null, "'off' must omit announce_volume (play at standing volume)");
    assert.equal(cfg.usePreAnnounce, true);
    assert.equal(cfg.announceRetries, 2);
    process.env.BROADCAST_ANNOUNCE_VOLUME = '80';
    assert.equal(loadBroadcastConfig().announceVolume, 80, 'explicit number → that volume');
    delete process.env.BROADCAST_ANNOUNCE_VOLUME;
    process.env.BROADCAST_VOLUME = '0.5';
    assert.equal(loadBroadcastConfig().announceVolume, 50, 'empty → BROADCAST_VOLUME × 100');
    delete process.env.BROADCAST_REPEAT;
    assert.equal(loadBroadcastConfig().repeat, 2, 'default repeat = 2');
    process.env.BROADCAST_REPEAT = '9';
    assert.equal(loadBroadcastConfig().repeat, 3, 'repeat clamps to 3');
    delete process.env.BROADCAST_USE_PRE_ANNOUNCE;
    assert.equal(loadBroadcastConfig().usePreAnnounce, false, 'pre-announce defaults off');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

/* ===================================================================
 * v0.15.8 — volume conflict-proofing. The announcement volume must be a SINGLE
 * source of truth: announce_volume, derived from BROADCAST_VOLUME when the
 * BROADCAST_ANNOUNCE_VOLUME override is blank. There is no competing volume_set
 * in the MA path. This pins the operator's exact config (BROADCAST_VOLUME=1,
 * announce-volume blank) resolving to a clean 100, with no other knob involved.
 * =================================================================== */
test('loadBroadcastConfig — BROADCAST_VOLUME=1 + blank announce-volume → announceVolume 100', () => {
  const saved = { ...process.env };
  try {
    process.env.BROADCAST_VOLUME = '1';
    delete process.env.BROADCAST_ANNOUNCE_VOLUME; // blank → follow BROADCAST_VOLUME
    const cfg = loadBroadcastConfig();
    assert.equal(cfg.announceVolume, 100, 'blank announce-volume + BROADCAST_VOLUME=1 → exactly 100');
    // The only volume knob in play is announceVolume; cfg.volume is just its source.
    assert.equal(cfg.volume, 1);
    // Explicit "" behaves identically to unset.
    process.env.BROADCAST_ANNOUNCE_VOLUME = '';
    assert.equal(loadBroadcastConfig().announceVolume, 100, 'empty string → also 100');
    // A literal "null" (a bashio quirk for an unset optional) must NOT be read as
    // "off" — it still falls back to BROADCAST_VOLUME × 100.
    process.env.BROADCAST_ANNOUNCE_VOLUME = 'null';
    assert.equal(loadBroadcastConfig().announceVolume, 100, "'null' falls back to BROADCAST_VOLUME × 100");
    // And the explicit standing-volume sentinel still omits announce_volume.
    process.env.BROADCAST_ANNOUNCE_VOLUME = 'off';
    assert.equal(loadBroadcastConfig().announceVolume, null, "'off' still omits announce_volume");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

/* ===================================================================
 * v0.15.7 — inter-repeat silence gap. A configurable pause is inserted between
 * the repeated annunciation passes so the operator can hear the message finish
 * and start again rather than the two passes running together. Default 1500 ms,
 * clamped 0..5000.
 * =================================================================== */
test('loadBroadcastConfig — v0.15.7 repeatGapMs default + clamp', () => {
  const saved = { ...process.env };
  try {
    delete process.env.BROADCAST_REPEAT_GAP_MS;
    assert.equal(loadBroadcastConfig().repeatGapMs, 1500, 'default inter-repeat gap = 1500 ms');
    process.env.BROADCAST_REPEAT_GAP_MS = '800';
    assert.equal(loadBroadcastConfig().repeatGapMs, 800, 'explicit value honored');
    process.env.BROADCAST_REPEAT_GAP_MS = '99999';
    assert.equal(loadBroadcastConfig().repeatGapMs, 5000, 'clamps to 5000');
    process.env.BROADCAST_REPEAT_GAP_MS = '-5';
    assert.equal(loadBroadcastConfig().repeatGapMs, 0, 'clamps to 0 (no gap)');
    process.env.BROADCAST_REPEAT_GAP_MS = '';
    assert.equal(loadBroadcastConfig().repeatGapMs, 1500, 'empty → default 1500');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
