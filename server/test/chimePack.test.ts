import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  generateAudioAssets,
  selectedChimePack,
  AUDIO_ASSETS,
  AUDIO_ASSETS_VERSION,
} from '../src/audioAssets.js';
import { parseWavHeader } from '../src/audioRenderer.js';

/**
 * v0.13.0 — power-plant chime pack. The pack is selected via
 * BROADCAST_CHIME_PACK (default "powerplant"), folded into the .assets-version
 * marker so switching packs regenerates the WAVs on next boot.
 */

test('selectedChimePack — default powerplant; airport when opted in', () => {
  const prev = process.env.BROADCAST_CHIME_PACK;
  try {
    delete process.env.BROADCAST_CHIME_PACK;
    assert.equal(selectedChimePack(), 'powerplant');
    process.env.BROADCAST_CHIME_PACK = 'airport';
    assert.equal(selectedChimePack(), 'airport');
    process.env.BROADCAST_CHIME_PACK = 'garbage';
    assert.equal(selectedChimePack(), 'powerplant', 'unknown pack falls back to powerplant');
  } finally {
    if (prev === undefined) delete process.env.BROADCAST_CHIME_PACK;
    else process.env.BROADCAST_CHIME_PACK = prev;
  }
});

test('generateAudioAssets — powerplant writes valid WAVs + pack-tagged marker', async () => {
  const prev = process.env.BROADCAST_CHIME_PACK;
  const dir = mkdtempSync(resolve(tmpdir(), 'chime-pp-'));
  try {
    process.env.BROADCAST_CHIME_PACK = 'powerplant';
    await generateAudioAssets(dir, () => {});
    for (const id of AUDIO_ASSETS) {
      const p = resolve(dir, `${id}.wav`);
      assert.ok(existsSync(p), `${id}.wav exists`);
      const h = parseWavHeader(readFileSync(p));
      assert.equal(h.ok, true, `${id}.wav is a valid WAV`);
      assert.equal(h.rate, 22050);
      assert.ok(h.dataLength > 1000, `${id}.wav has audio data`);
    }
    const marker = readFileSync(resolve(dir, '.assets-version'), 'utf8').trim();
    assert.equal(marker, `${AUDIO_ASSETS_VERSION}:powerplant`);
  } finally {
    if (prev === undefined) delete process.env.BROADCAST_CHIME_PACK;
    else process.env.BROADCAST_CHIME_PACK = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateAudioAssets — switching pack regenerates (marker changes, WAV bytes differ)', async () => {
  const prev = process.env.BROADCAST_CHIME_PACK;
  const dir = mkdtempSync(resolve(tmpdir(), 'chime-switch-'));
  try {
    process.env.BROADCAST_CHIME_PACK = 'powerplant';
    await generateAudioAssets(dir, () => {});
    const ppRed = readFileSync(resolve(dir, 'red-alert.wav'));
    assert.equal(readFileSync(resolve(dir, '.assets-version'), 'utf8').trim(), `${AUDIO_ASSETS_VERSION}:powerplant`);

    process.env.BROADCAST_CHIME_PACK = 'airport';
    await generateAudioAssets(dir, () => {});
    const airRed = readFileSync(resolve(dir, 'red-alert.wav'));
    assert.equal(readFileSync(resolve(dir, '.assets-version'), 'utf8').trim(), `${AUDIO_ASSETS_VERSION}:airport`);
    assert.ok(!ppRed.equals(airRed), 'powerplant and airport red-alert.wav must differ (regenerated on pack switch)');
  } finally {
    if (prev === undefined) delete process.env.BROADCAST_CHIME_PACK;
    else process.env.BROADCAST_CHIME_PACK = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
