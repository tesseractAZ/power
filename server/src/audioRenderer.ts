/**
 * v0.9.70 — Announcement renderer.
 *
 * Combines a klaxon WAV (synthesized at startup by audioAssets.ts) with
 * a TTS WAV (rendered on demand by wyomingTts.ts) into a single
 * announcement WAV. Caches the result on disk so repeated identical
 * announcements skip the render entirely.
 *
 * Layout:
 *
 *     ┌───────────────────────┬────────────────────────────────────┐
 *     │ klaxon (red/yellow/g) │ piper TTS rendering of the message │
 *     └───────────────────────┴────────────────────────────────────┘
 *      ~1.4 s (yellow/green)   ~0.5–6 s depending on message length
 *      ~3.0 s (red)
 *
 * Why combine into one WAV instead of two play_announcement calls:
 *
 *   - Music Assistant's play_announcement serializes per target — back-
 *     to-back calls hit a queue that needs ~5–8 sec to clear (the
 *     v0.9.43 wait window). Combining into one call eliminates that
 *     entire class of race condition.
 *   - One render = one cache hit on the wire. The HomePod/Sonos
 *     downloads the URL once and gets the full sequence.
 *   - Speaker volume + restore is atomic for the whole announcement.
 *
 * Why cache:
 *
 *   - Repeated alerts (same level, same message — e.g. the same offline-
 *     device alert re-firing every 10 min) skip the Wyoming roundtrip.
 *   - Cache key = sha1(version || level || message), so message changes
 *     bust the cache automatically.
 *   - Per-render version prefix in the key lets us invalidate every
 *     cached file by bumping the constant (without touching disk).
 *
 * Why not resample on mismatched sample rates:
 *
 *   - Piper's default voice (en_US-amy-medium) produces 22050 Hz mono
 *     16-bit, which matches audioAssets.ts exactly. Concat is a
 *     byte-splice — no resampling math, no quality loss.
 *   - If a user picks a Piper voice with a different sample rate,
 *     concat returns null and the caller falls back to klaxon-only.
 *     The alternative — implementing linear-interp resampling in JS —
 *     adds complexity that isn't paying for itself yet. Revisit if
 *     anyone actually hits this.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { renderWyomingTts, pcmToWav } from './wyomingTts.js';

/** Bump when the render pipeline changes in a way that invalidates the cache. */
export const RENDER_VERSION = 1;

export type AnnouncementLevel = 'red' | 'yellow' | 'green';

export interface RenderOptions {
  level: AnnouncementLevel;
  /** TTS text. Empty/null → klaxon-only (still cached, no Wyoming call). */
  message: string | null;
  /** Directory containing the pre-generated klaxon WAVs (e.g. /data/audio). */
  klaxonDir: string;
  /** Directory to cache combined announcement WAVs in. */
  cacheDir: string;
  /** Wyoming server hostname (default 'core-piper' from inside add-on). */
  wyomingHost: string;
  /** Wyoming server port (default 10200). */
  wyomingPort: number;
  /** Optional Piper voice override (e.g. "en_US-amy-medium"). */
  wyomingVoice?: string;
  /** Logger; receives one line per stage. */
  log: (m: string) => void;
}

export interface RenderResult {
  ok: boolean;
  /** Basename of the rendered file in cacheDir (e.g. "a1b2c3.wav"). */
  filename?: string;
  /** Full size in bytes. */
  sizeBytes?: number;
  /** Source breakdown for diagnostics. */
  fromCache?: boolean;
  ttsRenderMs?: number;
  /** Reason if ok=false. */
  error?: string;
}

interface WavHeader {
  ok: boolean;
  rate: number;
  width: number;       // bytes per sample (1, 2, or 4)
  channels: number;
  dataOffset: number;
  dataLength: number;
}

const KLAXON_FOR_LEVEL: Record<AnnouncementLevel, string> = {
  red: 'red-alert.wav',
  yellow: 'yellow-alert.wav',
  green: 'all-clear.wav',
};

/**
 * Render (or fetch from cache) the combined announcement WAV. Returns
 * the basename to serve via the panel's HTTP static route.
 */
export async function renderAnnouncement(opts: RenderOptions): Promise<RenderResult> {
  const { level, message, klaxonDir, cacheDir, wyomingHost, wyomingPort, wyomingVoice, log } = opts;

  // Cache key derivation: stable for the same (version, level, message).
  // Null message hashes distinctly from empty string so klaxon-only and
  // empty-spoken-message don't share a cache slot.
  const keyInput = `v${RENDER_VERSION}|${level}|${message ?? '<null>'}`;
  const hash = createHash('sha1').update(keyInput).digest('hex').slice(0, 16);
  const filename = `${hash}.wav`;
  const outPath = resolve(cacheDir, filename);

  // Cache hit short-circuit.
  if (existsSync(outPath)) {
    try {
      const st = await stat(outPath);
      return { ok: true, filename, sizeBytes: st.size, fromCache: true };
    } catch {
      // stat failed somehow — fall through to re-render
    }
  }

  // Load klaxon
  const klaxonPath = resolve(klaxonDir, KLAXON_FOR_LEVEL[level]);
  let klaxonWav: Buffer;
  try {
    klaxonWav = await readFile(klaxonPath);
  } catch (e: any) {
    return { ok: false, error: `klaxon read failed: ${e?.message ?? e}` };
  }
  const klaxonHeader = parseWavHeader(klaxonWav);
  if (!klaxonHeader.ok) {
    return { ok: false, error: `klaxon WAV malformed: ${klaxonPath}` };
  }

  // No TTS → klaxon-only path. Cache the klaxon directly under the hash
  // so the HTTP serving path is uniform.
  if (!message || message.trim().length === 0) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(outPath, klaxonWav);
      return { ok: true, filename, sizeBytes: klaxonWav.length, fromCache: false };
    } catch (e: any) {
      return { ok: false, error: `cache write failed: ${e?.message ?? e}` };
    }
  }

  // Render TTS
  const ttsResult = await renderWyomingTts({
    host: wyomingHost,
    port: wyomingPort,
    text: message,
    voice: wyomingVoice,
    timeoutMs: 15000,
  });
  if (!ttsResult.ok || !ttsResult.wav) {
    return { ok: false, error: ttsResult.error ?? 'wyoming render failed', ttsRenderMs: ttsResult.durationMs };
  }
  log(`audioRenderer: TTS rendered in ${ttsResult.durationMs}ms (${ttsResult.wav.length} bytes, ${ttsResult.rate}/${ttsResult.width}/${ttsResult.channels})`);

  // Validate format match — required for byte-splice concat.
  const ttsHeader = parseWavHeader(ttsResult.wav);
  if (!ttsHeader.ok) {
    return { ok: false, error: 'TTS WAV malformed (header parse failed)' };
  }
  if (klaxonHeader.rate !== ttsHeader.rate
      || klaxonHeader.width !== ttsHeader.width
      || klaxonHeader.channels !== ttsHeader.channels) {
    return {
      ok: false,
      error: `format mismatch — klaxon=${klaxonHeader.rate}/${klaxonHeader.width * 8}/${klaxonHeader.channels} tts=${ttsHeader.rate}/${ttsHeader.width * 8}/${ttsHeader.channels}`,
      ttsRenderMs: ttsResult.durationMs,
    };
  }

  // Concat PCM data, rebuild header.
  const klaxonPcm = klaxonWav.subarray(klaxonHeader.dataOffset, klaxonHeader.dataOffset + klaxonHeader.dataLength);
  const ttsPcm = ttsResult.wav.subarray(ttsHeader.dataOffset, ttsHeader.dataOffset + ttsHeader.dataLength);
  const combinedPcm = Buffer.concat([klaxonPcm, ttsPcm]);
  const combined = pcmToWav(combinedPcm, klaxonHeader.rate, klaxonHeader.width, klaxonHeader.channels);

  // Write atomically (tmp → rename) so a half-written file never serves.
  try {
    await mkdir(cacheDir, { recursive: true });
    const tmpPath = `${outPath}.tmp`;
    await writeFile(tmpPath, combined);
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, outPath);
  } catch (e: any) {
    return { ok: false, error: `cache write failed: ${e?.message ?? e}` };
  }

  return {
    ok: true,
    filename,
    sizeBytes: combined.length,
    fromCache: false,
    ttsRenderMs: ttsResult.durationMs,
  };
}

/**
 * Parse a 44-byte RIFF/WAVE header. Returns format params + the offset
 * + length of the 'data' chunk for byte-splice operations.
 *
 * Tolerates extra chunks between 'fmt ' and 'data' (Piper sometimes
 * emits a LIST chunk for metadata) by scanning for the 'data' marker.
 */
export function parseWavHeader(wav: Buffer): WavHeader {
  if (wav.length < 44) return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
  if (wav.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };

  // Locate 'fmt ' chunk (typically at offset 12)
  let cursor = 12;
  let rate = 0;
  let width = 0;
  let channels = 0;
  let fmtFound = false;
  while (cursor + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', cursor, cursor + 4);
    const chunkSize = wav.readUInt32LE(cursor + 4);
    const chunkBody = cursor + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = wav.readUInt16LE(chunkBody + 2);
      rate = wav.readUInt32LE(chunkBody + 4);
      const bitsPerSample = wav.readUInt16LE(chunkBody + 14);
      width = bitsPerSample / 8;
      fmtFound = true;
    } else if (chunkId === 'data') {
      if (!fmtFound) return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
      return { ok: true, rate, width, channels, dataOffset: chunkBody, dataLength: chunkSize };
    }
    // Chunk sizes are word-aligned in the spec (round up to even).
    cursor = chunkBody + chunkSize + (chunkSize % 2);
  }
  return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
}

/**
 * Optional cleanup helper — prunes cached announcement files older than
 * `maxAgeMs`. Called periodically by the broadcast monitor so the cache
 * doesn't grow unboundedly on installs with many unique alerts.
 */
export async function pruneRenderCache(cacheDir: string, maxAgeMs: number, log: (m: string) => void): Promise<number> {
  if (!existsSync(cacheDir)) return 0;
  const now = Date.now();
  let removed = 0;
  try {
    for (const name of await readdir(cacheDir)) {
      if (!name.endsWith('.wav')) continue;
      const full = resolve(cacheDir, name);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(full);
          removed++;
        }
      } catch { /* race with another writer — skip */ }
    }
  } catch (e: any) {
    log(`audioRenderer: prune failed: ${e?.message ?? e}`);
  }
  if (removed > 0) log(`audioRenderer: pruned ${removed} stale cache file(s)`);
  return removed;
}

/** Hash function exposed for tests so the cache-key format is pinned. */
export function renderCacheKey(level: AnnouncementLevel, message: string | null): string {
  return createHash('sha1')
    .update(`v${RENDER_VERSION}|${level}|${message ?? '<null>'}`)
    .digest('hex')
    .slice(0, 16);
}

/** Resolve a cached file path. Returns null if the file doesn't exist. */
export function cachedRenderPath(cacheDir: string, filename: string): string | null {
  const base = basename(filename);
  if (!/^[a-f0-9]{16}\.wav$/.test(base)) return null; // strict format
  const path = resolve(cacheDir, base);
  return existsSync(path) ? path : null;
}
