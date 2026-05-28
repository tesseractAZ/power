import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import { renderAnnouncement, renderCacheKey, parseWavHeader, pruneRenderCache, cachedRenderPath } from '../src/audioRenderer.js';
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
    // Has the klaxon's exact byte count (44-byte header + 1000 PCM)
    assert.equal(r.sizeBytes, 1044);
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
      log: () => {},
    });
    assert.equal(r.ok, true, `render failed: ${r.error}`);
    assert.ok(r.filename);
    assert.equal(r.fromCache, false);
    // Combined PCM = 500 (klaxon) + 800 (TTS) = 1300 bytes; +44 header = 1344
    assert.equal(r.sizeBytes, 1344);
    // Verify the cached file parses as a valid WAV with the right data length
    const wav = readFileSync(resolve(cacheDir, r.filename!));
    const h = parseWavHeader(wav);
    assert.equal(h.ok, true);
    assert.equal(h.rate, 22050);
    assert.equal(h.dataLength, 1300);
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
