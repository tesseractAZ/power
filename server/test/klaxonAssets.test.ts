import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateAudioAssets, AUDIO_ASSETS, AUDIO_ASSETS_VERSION } from '../src/audioAssets.js';
import { parseWavHeader } from '../src/audioRenderer.js';

/**
 * v1.56.0 — successor to chimePack.test.ts, which pinned BROADCAST_CHIME_PACK.
 * That option is gone; the level klaxons are now one fixed set. The properties
 * that test really protected are NOT about packs, and they survive here:
 *
 *   1. every level klaxon synthesizes to a valid, non-empty 22050 Hz WAV —
 *      these back the `builtin` assignment, which is the last-resort tone when
 *      an assigned tone's file is missing, so an empty or malformed klaxon is a
 *      silent alarm on the one path that only runs after something else failed;
 *   2. the .assets-version marker still drives regeneration, so a synthesis
 *      change actually reaches /data/audio instead of being masked by the
 *      existsSync short-circuit;
 *   3. the marker format change itself (`<n>:<pack>` -> `v<n>`) forces exactly
 *      one regeneration on upgrade — no install can keep stale klaxons.
 *
 * There is no mutation harness in this repo, so these are the only guards.
 */

test('level klaxons — all synthesize to valid non-empty 22050 Hz WAVs', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  try {
    await generateAudioAssets(dir, () => {});
    for (const id of AUDIO_ASSETS) {
      const p = resolve(dir, `${id}.wav`);
      assert.ok(existsSync(p), `${id}.wav exists`);
      const h = parseWavHeader(readFileSync(p));
      assert.equal(h.ok, true, `${id}.wav is a valid WAV`);
      assert.equal(h.rate, 22050, `${id}.wav is 22050 Hz`);
      assert.ok(h.dataLength > 1000, `${id}.wav carries audio data, not just a header`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marker is version-only, and a stale marker forces regeneration', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'klaxon-marker-'));
  try {
    await generateAudioAssets(dir, () => {});
    const markerPath = resolve(dir, '.assets-version');
    assert.equal(
      readFileSync(markerPath, 'utf8').trim(),
      `v${AUDIO_ASSETS_VERSION}`,
      'marker carries the version alone — no pack suffix',
    );

    // Corrupt a klaxon and stale the marker: regeneration must overwrite it.
    const victim = resolve(dir, `${AUDIO_ASSETS[0]}.wav`);
    writeFileSync(victim, Buffer.alloc(16));
    writeFileSync(markerPath, 'v0');
    await generateAudioAssets(dir, () => {});
    const h = parseWavHeader(readFileSync(victim));
    assert.equal(h.ok, true, 'a stale marker regenerated the corrupted klaxon');
    assert.ok(h.dataLength > 1000);
    assert.equal(readFileSync(markerPath, 'utf8').trim(), `v${AUDIO_ASSETS_VERSION}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every pre-v1.56.0 marker format is stale, so upgrades regenerate exactly once', async () => {
  // Pre-v0.13.0 wrote "<n>"; v0.13.0..v1.55.x wrote "<n>:<pack>". Neither can
  // equal "v<n>", so no install can carry stale klaxons across this upgrade.
  for (const legacy of [`${AUDIO_ASSETS_VERSION}`, `${AUDIO_ASSETS_VERSION}:powerplant`, `${AUDIO_ASSETS_VERSION}:airport`]) {
    assert.notEqual(legacy, `v${AUDIO_ASSETS_VERSION}`, `legacy marker ${legacy} must read as stale`);
  }
});
