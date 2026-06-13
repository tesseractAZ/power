import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import { renderAnnouncement, renderCacheKey, parseWavHeader, pruneRenderCache, cachedRenderPath, BUILTIN_CHIME_TAG, KLAXON_FOR_LEVEL } from '../src/audioRenderer.js';
import { getChimeRepeat } from '../src/alertSettings.js'; // v0.11.0 — klaxon repeats getChimeRepeat()× before TTS
import { pcmToWav } from '../src/wyomingTts.js';

/**
 * v0.9.70 — audioRenderer tests.
 *
 * The renderer's job: combine a pre-generated klaxon WAV with a
 * Wyoming-rendered TTS WAV into a single cached file. Tests cover:
 *   - Cache key stability + sensitivity (level/message change → new key)
 *   - WAV header parsing (RIFF/fmt /data chunk walking)
 *   - Klaxon-only path (no message) writes the klaxon as-is to cache
 *   - Full render combines klaxon + TTS into one valid WAV with summed
 *     PCM length and the original sample format preserved
 *   - Cache hits skip the Wyoming roundtrip
 *   - Format mismatch returns a clear error (no silent corruption)
 *   - Prune removes stale files, leaves fresh ones
 */

/** Spin up a tiny mock Wyoming server for the TTS render half. */
function startMockWyoming(rate: number, width: number, channels: number, pcm: Buffer): Promise<{ port: number; server: Server; renderCount: number }> {
  return new Promise((resolve) => {
    let renderCount = 0;
    const server = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0A);
        if (nl < 0) return;
        try {
          const header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
          if (header.type === 'synthesize') {
            renderCount++;
            sock.write(JSON.stringify({ type: 'audio-start', data: { rate, width, channels } }) + '\n');
            sock.write(JSON.stringify({ type: 'audio-chunk', data: {}, payload_length: pcm.length }) + '\n');
            sock.write(pcm);
            sock.write(JSON.stringify({ type: 'audio-stop' }) + '\n');
          }
        } catch { /* ignore */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      // Expose renderCount via closure
      const handle: any = { port, server, get renderCount() { return renderCount; } };
      resolve(handle);
    });
  });
}

/** Write a synthetic klaxon WAV to disk. */
function writeKlaxon(dir: string, name: string, rate: number, width: number, channels: number, pcmLength: number): string {
  const pcm = Buffer.alloc(pcmLength);
  for (let i = 0; i < pcmLength; i++) pcm[i] = (i * 3) & 0xff;
  const wav = pcmToWav(pcm, rate, width, channels);
  const path = resolve(dir, name);
  writeFileSync(path, wav);
  return path;
}

test('renderCacheKey — same (version, level, message) → same hash', () => {
  const a = renderCacheKey('red', 'hello');
  const b = renderCacheKey('red', 'hello');
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.match(a, /^[a-f0-9]{16}$/);
});

test('renderCacheKey — different level or message → different hash', () => {
  const base = renderCacheKey('red', 'hello');
  assert.notEqual(base, renderCacheKey('yellow', 'hello'));
  assert.notEqual(base, renderCacheKey('red', 'hello!'));
  assert.notEqual(base, renderCacheKey('red', null));
});

test('renderCacheKey — null message hashes distinctly from empty string', () => {
  assert.notEqual(renderCacheKey('red', null), renderCacheKey('red', ''));
});

test('parseWavHeader — extracts rate/width/channels/dataOffset/dataLength', () => {
  const pcm = Buffer.alloc(300);
  const wav = pcmToWav(pcm, 22050, 2, 1);
  const h = parseWavHeader(wav);
  assert.equal(h.ok, true);
  assert.equal(h.rate, 22050);
  assert.equal(h.width, 2);
  assert.equal(h.channels, 1);
  assert.equal(h.dataOffset, 44);
  assert.equal(h.dataLength, 300);
});

test('parseWavHeader — malformed input → ok=false', () => {
  assert.equal(parseWavHeader(Buffer.from('not a wav')).ok, false);
  assert.equal(parseWavHeader(Buffer.alloc(10)).ok, false);
});

test('renderAnnouncement — klaxon-only (null message) caches the klaxon as-is, no Wyoming call', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeKlaxon(klaxonDir, 'yellow-alert.wav', 22050, 2, 1, 1000);
    const r = await renderAnnouncement({
      level: 'yellow',
      message: null,
      klaxonDir,
      cacheDir,
      wyomingHost: '127.0.0.1',
      wyomingPort: 1, // would refuse — proves we didn't call
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.ok(r.filename);
    assert.equal(r.fromCache, false);
    // File exists in cache
    assert.ok(existsSync(resolve(cacheDir, r.filename!)));
    // v0.11.0 — the chime repeats getChimeRepeat()× even on the klaxon-only path
    // (44-byte header + N × 1000 PCM).
    const N = getChimeRepeat();
    assert.equal(r.sizeBytes, 44 + N * 1000);
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — klaxon + TTS combined into one WAV (PCM lengths sum)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 500);
  const ttsPcm = Buffer.alloc(800);
  for (let i = 0; i < 800; i++) ttsPcm[i] = (i * 11) & 0xff;
  const mock = await startMockWyoming(22050, 2, 1, ttsPcm);
  try {
    const r = await renderAnnouncement({
      level: 'red',
      message: 'hello',
      klaxonDir,
      cacheDir,
      wyomingHost: '127.0.0.1',
      wyomingPort: mock.port,
      chimeGapMs: 0, // v0.15.15 — gap tested separately; 0 keeps the PCM-sum check exact
      log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    assert.ok(r.filename);
    assert.equal(r.fromCache, false);
    // v0.11.0 — Combined PCM = N × 500 (klaxon, repeated) + 800 (TTS); +44 header.
    const N = getChimeRepeat();
    const pcmLen = N * 500 + 800;
    assert.equal(r.sizeBytes, 44 + pcmLen);
    // Verify the cached file parses as a valid WAV with the right data length
    const wav = readFileSync(resolve(cacheDir, r.filename!));
    const h = parseWavHeader(wav);
    assert.equal(h.ok, true);
    assert.equal(h.rate, 22050);
    assert.equal(h.dataLength, pcmLen);
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — cache hit skips Wyoming call entirely', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 200);
  const mock = await startMockWyoming(22050, 2, 1, Buffer.alloc(100));
  try {
    // First render — populates cache
    const r1 = await renderAnnouncement({
      level: 'red', message: 'hi', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.fromCache, false);
    const renderCountAfterFirst = (mock as any).renderCount;

    // Second identical render — must hit cache, no new Wyoming call
    const r2 = await renderAnnouncement({
      level: 'red', message: 'hi', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.fromCache, true);
    assert.equal(r2.filename, r1.filename, 'same input should yield same cache filename');
    assert.equal((mock as any).renderCount, renderCountAfterFirst, 'Wyoming should NOT have been hit again');
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — different messages produce different cache files', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 100);
  const mock = await startMockWyoming(22050, 2, 1, Buffer.alloc(50));
  try {
    const r1 = await renderAnnouncement({
      level: 'red', message: 'message one', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    const r2 = await renderAnnouncement({
      level: 'red', message: 'message two', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.filename, r2.filename, 'distinct messages should not collide');
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — format mismatch (klaxon 22050 vs TTS 16000) returns clear error', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 100);
  // Mock Wyoming reports 16000 Hz (incompatible)
  const mock = await startMockWyoming(16000, 2, 1, Buffer.alloc(50));
  try {
    const r = await renderAnnouncement({
      level: 'red', message: 'hi', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('format mismatch'), `expected format mismatch error, got: ${r.error}`);
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — missing klaxon file returns clear error', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    const r = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, log: () => {},
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('klaxon read failed'), `expected klaxon error, got: ${r.error}`);
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('pruneRenderCache — removes files older than maxAge, keeps fresh', async () => {
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-prune-'));
  try {
    // Write three files; touch one with a very old mtime
    writeFileSync(resolve(cacheDir, 'aaaaaaaaaaaaaaaa.wav'), Buffer.alloc(10));
    writeFileSync(resolve(cacheDir, 'bbbbbbbbbbbbbbbb.wav'), Buffer.alloc(10));
    writeFileSync(resolve(cacheDir, 'cccccccccccccccc.wav'), Buffer.alloc(10));
    // Forcibly age the first one by 30 days
    const { utimes } = await import('node:fs/promises');
    const oldMs = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(resolve(cacheDir, 'aaaaaaaaaaaaaaaa.wav'), oldMs, oldMs);
    // Prune anything older than 7 days
    const removed = await pruneRenderCache(cacheDir, 7 * 24 * 60 * 60 * 1000, () => {});
    assert.equal(removed, 1);
    assert.equal(existsSync(resolve(cacheDir, 'aaaaaaaaaaaaaaaa.wav')), false);
    assert.equal(existsSync(resolve(cacheDir, 'bbbbbbbbbbbbbbbb.wav')), true);
    assert.equal(existsSync(resolve(cacheDir, 'cccccccccccccccc.wav')), true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// v0.12.1 — lead-in silence: prepended before the first chime so multi-room /
// AirPlay speakers can sync before any audio. Frame-aligned zero PCM, folded
// into the cache key.

/** Bytes of silence for a given format + ms — mirrors makeSilencePcm(). */
function silenceBytes(rate: number, width: number, channels: number, ms: number): number {
  return Math.round((rate * ms) / 1000) * channels * width;
}

test('renderCacheKey — lead-in silence is part of the key', () => {
  const base = renderCacheKey('red', 'hello', 2, 0);
  assert.equal(base, renderCacheKey('red', 'hello', 2, 0), 'same lead → same key');
  assert.notEqual(base, renderCacheKey('red', 'hello', 2, 1000), 'different lead → different key');
  // default (undefined) lead resolves to 0, matching an explicit 0
  assert.equal(renderCacheKey('red', 'hello', 2), renderCacheKey('red', 'hello', 2, 0));
});

test('renderAnnouncement — leadSilenceMs prepends frame-aligned silence (klaxon-only)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeKlaxon(klaxonDir, 'yellow-alert.wav', 22050, 2, 1, 1000);
    const r = await renderAnnouncement({
      level: 'yellow', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, // would refuse — proves no Wyoming call
      leadSilenceMs: 1000, log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    const N = getChimeRepeat();
    const sil = silenceBytes(22050, 2, 1, 1000); // 22050 frames × 2 bytes = 44100
    assert.equal(r.sizeBytes, 44 + sil + N * 1000);
    // The prepended region must be actual digital silence (all zeros).
    const wav = readFileSync(resolve(cacheDir, r.filename!));
    const h = parseWavHeader(wav);
    assert.equal(h.ok, true);
    assert.equal(h.dataLength, sil + N * 1000);
    const lead = wav.subarray(h.dataOffset, h.dataOffset + sil);
    assert.ok(lead.every((b) => b === 0), 'lead-in region should be all-zero PCM');
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — leadSilenceMs prepends silence ahead of klaxon+TTS', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 500);
  const ttsPcm = Buffer.alloc(800);
  for (let i = 0; i < 800; i++) ttsPcm[i] = ((i * 11) & 0xff) || 1; // non-zero so the zero-check is meaningful
  const mock = await startMockWyoming(22050, 2, 1, ttsPcm);
  try {
    const r = await renderAnnouncement({
      level: 'red', message: 'hello', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port,
      leadSilenceMs: 500, chimeGapMs: 0, log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    const N = getChimeRepeat();
    const sil = silenceBytes(22050, 2, 1, 500); // 11025 frames × 2 = 22050 bytes
    assert.equal(r.sizeBytes, 44 + sil + N * 500 + 800);
    const wav = readFileSync(resolve(cacheDir, r.filename!));
    const h = parseWavHeader(wav);
    assert.equal(h.dataLength, sil + N * 500 + 800);
    const lead = wav.subarray(h.dataOffset, h.dataOffset + sil);
    assert.ok(lead.every((b) => b === 0), 'lead-in region should be all-zero PCM');
    // The klaxon+TTS region following the silence must carry signal (not all zero).
    const body = wav.subarray(h.dataOffset + sil);
    assert.ok(body.some((b) => b !== 0), 'klaxon+TTS should follow the silence');
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — leadSilenceMs 0 vs undefined are the same cache file', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 300);
    const r0 = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, leadSilenceMs: 0, log: () => {},
    });
    const rU = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, log: () => {}, // leadSilenceMs undefined → 0
    });
    assert.equal(r0.ok, true);
    assert.equal(rU.ok, true);
    assert.equal(r0.filename, rU.filename, 'leadSilenceMs:0 and undefined must share a cache slot');
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cachedRenderPath — strict filename format check (no path traversal)', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeFileSync(resolve(dir, '0123456789abcdef.wav'), Buffer.alloc(10));
    // Valid filename → existing path
    assert.equal(cachedRenderPath(dir, '0123456789abcdef.wav'), resolve(dir, '0123456789abcdef.wav'));
    // Non-existing valid filename → null
    assert.equal(cachedRenderPath(dir, 'aaaaaaaaaaaaaaaa.wav'), null);
    // Path traversal attempt → null (rejected by regex)
    assert.equal(cachedRenderPath(dir, '../etc/passwd'), null);
    // Wrong extension → null
    assert.equal(cachedRenderPath(dir, '0123456789abcdef.mp3'), null);
    // Wrong length → null
    assert.equal(cachedRenderPath(dir, 'short.wav'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// v0.15.4 — announceRepeat: the entire chime+TTS block is rendered N times into
// ONE cached WAV, so a single (reliable) Music Assistant announce call replays
// the whole annunciation. This catches a missed first pass on the ecobee
// speakers without a second flaky service call. announceRepeat folds into the
// cache key so repeat=1 and repeat=2 never alias.

test('renderCacheKey — announceRepeat is part of the key', () => {
  const base = renderCacheKey('red', 'hi', 2, 0, 1);
  assert.equal(base, renderCacheKey('red', 'hi', 2, 0, 1), 'same announceRepeat → same key');
  assert.notEqual(base, renderCacheKey('red', 'hi', 2, 0, 2), 'different announceRepeat → different key');
  // default (undefined) announceRepeat resolves to 1, matching an explicit 1
  assert.equal(renderCacheKey('red', 'hi', 2, 0), renderCacheKey('red', 'hi', 2, 0, 1));
});

// v0.15.4 — resource-exhaustion guard (CodeQL js/resource-exhaustion). The chime
// repeat feeds Array(chimeRepeat[*announceRepeat]) allocations, so it MUST be
// bounded at the point of use. getChimeRepeat() already clamps to ≤4, but the
// renderer/cache-key re-assert a hard ceiling (MAX_CHIME_REPEAT = 8) so an absurd
// value can never grow the buffer — or the key space — without limit. We pin the
// behaviour via the cache key (the same clamp the renderer applies).
test('renderCacheKey — chimeRepeat is bounded at the allocation ceiling (no unbounded growth)', () => {
  // Two absurd values collapse to the same key → the value is being clamped, not
  // used raw (a raw value would make these differ).
  assert.equal(
    renderCacheKey('red', 'hi', 9999, 0, 1),
    renderCacheKey('red', 'hi', 10000, 0, 1),
    'huge chimeRepeat values must clamp to the same ceiling',
  );
  // The clamped huge value equals the key at the documented ceiling (8)…
  assert.equal(
    renderCacheKey('red', 'hi', 9999, 0, 1),
    renderCacheKey('red', 'hi', 8, 0, 1),
    'clamped value must equal the key at MAX_CHIME_REPEAT (8)',
  );
  // …and is distinct from a below-ceiling value, so the cap is a ceiling, not a floor.
  assert.notEqual(
    renderCacheKey('red', 'hi', 8, 0, 1),
    renderCacheKey('red', 'hi', 4, 0, 1),
    'below-ceiling repeat values must still be distinguished',
  );
});

test('renderAnnouncement — announceRepeat repeats the chime block + busts the cache (klaxon-only)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeKlaxon(klaxonDir, 'all-clear.wav', 22050, 2, 1, 200);
    const N = getChimeRepeat();
    const r1 = await renderAnnouncement({
      level: 'green', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, // would refuse — proves no Wyoming call
      announceRepeat: 1, log: () => {},
    });
    const r2 = await renderAnnouncement({
      level: 'green', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1,
      announceRepeat: 2, log: () => {},
    });
    assert.equal(r1.ok, true, `render failed: ${r1.error}`);
    assert.equal(r2.ok, true, `render failed: ${r2.error}`);
    assert.notEqual(r1.filename, r2.filename, 'announceRepeat must bust the cache');
    // klaxon-only path: dataLength = chimeRepeat × announceRepeat × pcmLength
    assert.equal(r1.sizeBytes, 44 + N * 200);
    assert.equal(r2.sizeBytes, 44 + N * 2 * 200);
    const h1 = parseWavHeader(readFileSync(resolve(cacheDir, r1.filename!)));
    const h2 = parseWavHeader(readFileSync(resolve(cacheDir, r2.filename!)));
    assert.equal(h2.dataLength, 2 * h1.dataLength, 'announceRepeat=2 is exactly twice the PCM of =1');
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// v0.15.7 — inter-repeat silence gap: between the repeated passes we insert
// repeatGapMs of silence so the listener can tell the message ended and is
// repeating. Folded into the cache key; for announceRepeat=2 exactly ONE gap is
// inserted (between the two blocks), so it adds exactly gapBytes to the PCM.
test('renderCacheKey — repeatGapMs is part of the key', () => {
  const base = renderCacheKey('red', 'hi', 2, 0, 2, 0);
  assert.equal(base, renderCacheKey('red', 'hi', 2, 0, 2, 0), 'same gap → same key');
  assert.notEqual(base, renderCacheKey('red', 'hi', 2, 0, 2, 500), 'different gap → different key');
  // default (undefined) gap resolves to 0
  assert.equal(renderCacheKey('red', 'hi', 2, 0, 2), renderCacheKey('red', 'hi', 2, 0, 2, 0));
});

test('renderAnnouncement — repeatGapMs inserts one silence gap between two passes (klaxon-only)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    writeKlaxon(klaxonDir, 'all-clear.wav', 22050, 2, 1, 200);
    const N = getChimeRepeat();
    const noGap = await renderAnnouncement({
      level: 'green', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1, // would refuse — proves no Wyoming call
      announceRepeat: 2, repeatGapMs: 0, log: () => {},
    });
    const withGap = await renderAnnouncement({
      level: 'green', message: null, klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: 1,
      announceRepeat: 2, repeatGapMs: 500, log: () => {},
    });
    assert.equal(noGap.ok, true, `render failed: ${noGap.error}`);
    assert.equal(withGap.ok, true, `render failed: ${withGap.error}`);
    assert.notEqual(noGap.filename, withGap.filename, 'repeatGapMs must bust the cache');
    const gapBytes = silenceBytes(22050, 2, 1, 500); // 11025 frames × 2 = 22050 bytes
    // announceRepeat=2 → two blocks of (N × 200) PCM + exactly ONE gap between them.
    assert.equal(noGap.sizeBytes, 44 + N * 2 * 200);
    assert.equal(withGap.sizeBytes, 44 + N * 2 * 200 + gapBytes);
    // The gap region must be actual silence: locate it right after the first block.
    const wav = readFileSync(resolve(cacheDir, withGap.filename!));
    const h = parseWavHeader(wav);
    const firstBlockBytes = N * 200;
    const gapRegion = wav.subarray(h.dataOffset + firstBlockBytes, h.dataOffset + firstBlockBytes + gapBytes);
    assert.ok(gapRegion.every((b) => b === 0), 'inter-repeat gap must be all-zero PCM');
  } finally {
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

/* ─── v0.15.15 — post-chime silence gap (chime → pause → spoken message) ───
 * A chimeGapMs of digital silence (default 1000) sits between the chime group
 * and the TTS inside every repeated block, so the chime fully decays before
 * the announcement begins. Klaxon-only renders are unaffected (nothing follows
 * the chime). The gap folds into the cache key so 0 and 1000 never alias. */

test('renderCacheKey — chimeGapMs is part of the key; undefined defaults to 1000', () => {
  const base = renderCacheKey('red', 'hi', 2, 0, 1, 0, 1000);
  assert.equal(base, renderCacheKey('red', 'hi', 2, 0, 1, 0, 1000), 'same gap → same key');
  assert.notEqual(base, renderCacheKey('red', 'hi', 2, 0, 1, 0, 0), 'different gap → different key');
  // default (undefined) resolves to 1000, matching an explicit 1000
  assert.equal(renderCacheKey('red', 'hi', 2, 0, 1, 0), base);
});

test('renderAnnouncement — chimeGapMs inserts all-zero silence between chime and TTS', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'red-alert.wav', 22050, 2, 1, 500);
  const ttsPcm = Buffer.alloc(800);
  for (let i = 0; i < 800; i++) ttsPcm[i] = ((i * 11) & 0xff) || 1; // non-zero TTS body
  const mock = await startMockWyoming(22050, 2, 1, ttsPcm);
  try {
    const r = await renderAnnouncement({
      level: 'red', message: 'hello', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port,
      chimeGapMs: 1000, log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    const N = getChimeRepeat();
    const gap = silenceBytes(22050, 2, 1, 1000); // 22050 frames × 2 bytes = 44100
    assert.equal(r.sizeBytes, 44 + N * 500 + gap + 800);
    // The region between the chime group and the TTS must be true digital silence.
    const wav = readFileSync(resolve(cacheDir, r.filename!));
    const h = parseWavHeader(wav);
    assert.equal(h.ok, true);
    assert.equal(h.dataLength, N * 500 + gap + 800);
    const gapRegion = wav.subarray(h.dataOffset + N * 500, h.dataOffset + N * 500 + gap);
    assert.ok(gapRegion.every((b) => b === 0), 'post-chime gap should be all-zero PCM');
    const tts = wav.subarray(h.dataOffset + N * 500 + gap);
    assert.ok(tts.some((b) => b !== 0), 'TTS should follow the gap');
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('renderAnnouncement — default chimeGap (1s) applies when option omitted', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  writeKlaxon(klaxonDir, 'yellow-alert.wav', 22050, 2, 1, 500);
  const ttsPcm = Buffer.alloc(600);
  for (let i = 0; i < 600; i++) ttsPcm[i] = ((i * 7) & 0xff) || 1;
  const mock = await startMockWyoming(22050, 2, 1, ttsPcm);
  try {
    const r = await renderAnnouncement({
      level: 'yellow', message: 'heads up', klaxonDir, cacheDir,
      wyomingHost: '127.0.0.1', wyomingPort: mock.port, log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    const N = getChimeRepeat();
    const gap = silenceBytes(22050, 2, 1, 1000);
    assert.equal(r.sizeBytes, 44 + N * 500 + gap + 600, 'omitted chimeGapMs must default to 1000ms');
  } finally {
    mock.server.close();
    rmSync(klaxonDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

/* ─── v0.15.23 — custom-chime cache key + chimePath override (Alert Console) ─ */

function tinyWav(freq: number, frames = 200): Buffer {
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 22050) * 20000), i * 2);
  return pcmToWav(pcm, 22050, 2, 1);
}

test('renderCacheKey — builtin tag is BYTE-IDENTICAL to the pre-feature key (zero churn)', () => {
  const noTag = renderCacheKey('red', 'msg', 2, 1000, 1, 0, 1000);
  const builtin = renderCacheKey('red', 'msg', 2, 1000, 1, 0, 1000, BUILTIN_CHIME_TAG);
  assert.equal(builtin, noTag, 'BUILTIN_CHIME_TAG must omit the tag component → unchanged keys for default users');
});

test('renderCacheKey — a custom chime tag busts the cache', () => {
  const builtin = renderCacheKey('red', 'msg', 2, 1000, 1, 0, 1000, BUILTIN_CHIME_TAG);
  const custom = renderCacheKey('red', 'msg', 2, 1000, 1, 0, 1000, 'abc1230000000000');
  assert.notEqual(custom, builtin, 'a custom tone id must produce a distinct key');
  // Two different custom tones differ from each other too.
  assert.notEqual(custom, renderCacheKey('red', 'msg', 2, 1000, 1, 0, 1000, 'def4560000000000'));
});

test('renderAnnouncement ↔ renderCacheKey lock-step for a custom chime (klaxon-only path)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klax-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  const chimeDir = mkdtempSync(resolve(tmpdir(), 'tone-'));
  try {
    // Built-in klaxons + a custom tone, both in the renderer's format.
    for (const f of Object.values(KLAXON_FOR_LEVEL)) writeFileSync(resolve(klaxonDir, f), tinyWav(440));
    const customPath = resolve(chimeDir, 'custom.wav');
    writeFileSync(customPath, tinyWav(880));
    const tag = 'feedface12345678';

    // message:null → klaxon-only (no Wyoming needed). The returned filename MUST
    // equal renderCacheKey(...) with the SAME tag — the lock-step the critic required.
    const r = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      chimePath: customPath, chimeTag: tag,
      wyomingHost: 'unused', wyomingPort: 0, log: () => {},
    });
    assert.ok(r.ok, r.error);
    const expected = renderCacheKey('red', null, getChimeRepeat(), 0, 1, 0, 1000, tag) + '.wav';
    assert.equal(r.filename, expected, 'rendered filename must match the predicted cache key for the custom tag');

    // A different tag → different filename (cache actually busts on swap).
    const r2 = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      chimePath: customPath, chimeTag: BUILTIN_CHIME_TAG,
      wyomingHost: 'unused', wyomingPort: 0, log: () => {},
    });
    assert.notEqual(r2.filename, r.filename);
  } finally {
    for (const d of [klaxonDir, cacheDir, chimeDir]) rmSync(d, { recursive: true, force: true });
  }
});

test('renderAnnouncement — a missing custom chime FALLS BACK to the built-in klaxon (never silent)', async () => {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'klax-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'cache-'));
  try {
    for (const f of Object.values(KLAXON_FOR_LEVEL)) writeFileSync(resolve(klaxonDir, f), tinyWav(440));
    const r = await renderAnnouncement({
      level: 'red', message: null, klaxonDir, cacheDir,
      chimePath: resolve(klaxonDir, 'does-not-exist.wav'), chimeTag: 'missing0000000000',
      wyomingHost: 'unused', wyomingPort: 0, log: () => {},
    });
    assert.ok(r.ok, 'a missing custom chime must still render (built-in fallback), not fail');
    assert.ok((r.sizeBytes ?? 0) > 44, 'fallback produced real audio');
  } finally {
    for (const d of [klaxonDir, cacheDir]) rmSync(d, { recursive: true, force: true });
  }
});
