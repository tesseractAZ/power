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
 *     ┌─────────────┬───────────────────────┬────────────────────────────────────┐
 *     │ lead-in gap │ klaxon × N (default 2) │ piper TTS rendering of the message │
 *     └─────────────┴───────────────────────┴────────────────────────────────────┘
 *      ~1.0 s silent  ~1.4 s (yellow/green)   ~0.5–6 s depending on message length
 *      (default)      ~3.0 s (red), × N       (N = getChimeRepeat(), part of cache key)
 *
 * Why the lead-in gap (v0.12.1):
 *
 *   - Multi-room players — AirPlay devices especially (e.g. Ecobee
 *     thermostats exposed as Music Assistant AirPlay players) — take a
 *     beat to establish the audio stream when an announcement starts. With
 *     no lead-in, the first fraction of the chime is clipped on every
 *     speaker, and the SLOWEST device can still be negotiating when a short
 *     clip ends → it plays nothing at all and seems to "miss" the alert.
 *   - Prepending leadSilenceMs of digital silence (zero-filled PCM, frame-
 *     aligned to the WAV format) gives every speaker time to sync up before
 *     any meaningful audio. It is part of the cache key, so changing the
 *     amount re-renders automatically. leadSilenceMs = 0 disables it.
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
 *   - Cache key = sha1(version || level || chimeRepeat || message), so a
 *     message change OR a chime-repeat change busts the cache automatically.
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
import { verbalizeForTts } from './ttsService.js';
import { getChimeRepeat } from './alertSettings.js';
import { AUDIO_ASSETS_VERSION } from './audioAssets.js';

/** Bump when the render pipeline changes in a way that invalidates the cache.
 *  v2 (v0.12.1): the optional lead-in silence is now part of every render.
 *  v3 (v0.15.4): announce-repeat folded into the key.
 *  v4 (v0.15.7): inter-repeat silence gap folded into the key.
 *  v5 (v0.15.15): post-chime silence gap (chime → pause → spoken message).
 *  v6 (v0.23.0): one-time flush of every combined render after the tone-onset
 *      fix (softened named-tone attacks), so any stale/short cached clip from
 *      the v0.17.0 tone rebuild is re-rendered with the corrected tones. The
 *      audio-asset version is ALSO folded into named/custom keys below so a
 *      future asset regeneration auto-invalidates dependent combined renders. */
export const RENDER_VERSION = 6;

/** v0.15.4 — hard ceiling on the chime-repeat count at the allocation site.
 *  getChimeRepeat() is already clamped to ≤4 by alertSettings; this is a
 *  belt-and-suspenders bound (well above that max) so the Buffer arrays built
 *  from it can never allocate without limit, even if the upstream clamp changes.
 *  Applied identically in renderAnnouncement and renderCacheKey so the rendered
 *  audio and the predicted cache filename stay in lock-step. */
const MAX_CHIME_REPEAT = 8;

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
  /**
   * v0.12.1 — milliseconds of digital silence to prepend before the first
   * chime, so multi-room/AirPlay speakers can establish their stream before
   * any audible audio (fixes the clipped start + slow AirPlay devices missing
   * the announcement). Part of the cache key. Default/undefined → 0 (no lead-in).
   */
  leadSilenceMs?: number;
  /**
   * v0.15.4 — number of times the whole (chime×N + spoken message) block repeats
   * in the single rendered WAV, so a missed first annunciation gets a second pass
   * within the same MA announcement. Clamped 1..3. Part of the cache key.
   * Default/undefined → 1 (no repeat).
   */
  announceRepeat?: number;
  /**
   * v0.15.7 — milliseconds of digital silence inserted BETWEEN the repeated
   * (chime + spoken message) blocks, so the listener can hear the message
   * conclude and start again rather than the two passes running together. Only
   * applies when announceRepeat > 1. Part of the cache key. Default/undefined → 0.
   */
  repeatGapMs?: number;
  /**
   * v0.15.15 — milliseconds of digital silence inserted AFTER the chime group,
   * before the spoken message, so the chime decays and the announcement starts
   * cleanly instead of riding the chime's tail. Applies inside every repeated
   * block. Part of the cache key. Default/undefined → 1000.
   */
  chimeGapMs?: number;
  /**
   * v0.15.23 — absolute path to the chime WAV to prepend, OVERRIDING the
   * built-in klaxon at klaxonDir/KLAXON_FOR_LEVEL[level]. The operator's Alert
   * Console assigns a custom tone per level (chimeConfig.resolveChime). The
   * file MUST be the renderer's format (22050/16/mono — chimeStore normalizes
   * every upload to it). When the custom file is unreadable, the renderer
   * FALLS BACK to the built-in klaxon for the level rather than failing the
   * whole announcement (never a silent alarm). Undefined → built-in klaxon.
   */
  chimePath?: string;
  /**
   * v0.15.23 — cache-key identity for the resolved chime. The render cache key
   * keys off `level`, not the chime file, so a tone swap would serve a STALE
   * render without this. Pass BUILTIN_CHIME_TAG for the klaxon (component
   * omitted → byte-identical to pre-feature keys) or the custom tone's content
   * id otherwise. MUST match what chimeConfig.resolveChime returns alongside
   * chimePath, so the rendered audio and the cache key stay in lock-step.
   */
  chimeTag?: string;
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

export const KLAXON_FOR_LEVEL: Record<AnnouncementLevel, string> = {
  red: 'red-alert.wav',
  yellow: 'yellow-alert.wav',
  green: 'all-clear.wav',
};

/** v0.15.23 — cache-key tag for the built-in klaxon. A single fixed literal so
 *  builtin cache keys are BYTE-IDENTICAL to the pre-feature key string (the tag
 *  component is omitted entirely for this value — see renderCacheKey), giving
 *  zero cache churn for operators who never assign a custom tone. Kept in sync
 *  with chimeConfig.BUILTIN_TAG (duplicated here to avoid an import cycle). */
export const BUILTIN_CHIME_TAG = 'builtin';

/**
 * v0.12.1 — a frame-aligned, zero-filled PCM buffer of `leadMs` milliseconds of
 * silence at the given WAV format. Zeros are mid-scale (true silence) for signed
 * PCM, so no DSP is needed. Frame size = channels × bytes-per-sample, so the
 * length is rounded to a whole number of frames — otherwise the downstream
 * byte-splice would misalign every following sample. Returns an empty buffer for
 * leadMs ≤ 0 or a degenerate format.
 */
function makeSilencePcm(header: WavHeader, leadMs: number): Buffer {
  if (leadMs <= 0 || header.rate <= 0 || header.width <= 0 || header.channels <= 0) {
    return Buffer.alloc(0);
  }
  const frames = Math.round((header.rate * leadMs) / 1000);
  return Buffer.alloc(frames * header.channels * header.width);
}

/**
 * Render (or fetch from cache) the combined announcement WAV. Returns
 * the basename to serve via the panel's HTTP static route.
 */
export async function renderAnnouncement(opts: RenderOptions): Promise<RenderResult> {
  const { level, message, klaxonDir, cacheDir, wyomingHost, wyomingPort, wyomingVoice, log } = opts;

  // v0.11.0 — chime repeats getChimeRepeat() times (default 2) before the TTS.
  // Resolve N once here so it's part of both the rendered audio AND the cache
  // key — changing the repeat count must invalidate any previously cached file.
  // v0.15.4 — re-assert a hard upper bound at the point of use. getChimeRepeat()
  // is already clamped to ≤4 by clampChime(), but bounding locally guarantees the
  // Array(chimeRepeat[*announceRepeat]) allocations below can never grow unbounded
  // even if that distant clamp regresses — defense-in-depth on the alert path.
  // The cap is well above the settings max, so it never changes real behaviour or
  // the cache key. NOTE: this is written as an explicit comparison GUARD rather
  // than Math.min() on purpose — CodeQL's js/resource-exhaustion taint tracker
  // recognises a relational upper-bound check as a sanitizer, but not Math.min(),
  // and the guard must be inline here (an interprocedural helper isn't trusted at
  // the allocation sink).
  let chimeRepeat = Math.max(1, Math.round(getChimeRepeat()));
  if (chimeRepeat > MAX_CHIME_REPEAT) chimeRepeat = MAX_CHIME_REPEAT;
  // v0.15.4 — repeat the whole (chime + spoken message) block N times so a missed
  // first annunciation gets a second pass. Clamped 1..3; part of the cache key.
  const announceRepeat = Math.max(1, Math.min(3, Math.round(opts.announceRepeat ?? 1)));

  // v0.12.1 — lead-in silence (ms) prepended before the first chime. Resolved
  // once so it's part of both the rendered audio AND the cache key.
  const leadMs = Math.max(0, Math.round(opts.leadSilenceMs ?? 0));
  // v0.15.7 — silence (ms) inserted between repeated blocks so the repeat is
  // audibly distinct. Only meaningful when announceRepeat > 1. Part of the key.
  const repeatGapMs = Math.max(0, Math.round(opts.repeatGapMs ?? 0));
  // v0.15.15 — silence (ms) after the chime group, before the spoken message.
  const chimeGapMs = Math.max(0, Math.round(opts.chimeGapMs ?? 1000));

  // Cache key derivation: stable for the same (version, level, message, repeat,
  // lead silence). Null message hashes distinctly from empty string so klaxon-
  // only and empty-spoken-message don't share a cache slot. The repeat count
  // and lead-in are part of the key so changing either busts the cache.
  // v0.15.4 — single source of truth for the cache key (shared with the exported
  // renderCacheKey, which callers use to predict the served filename).
  // v0.15.23 — resolve the chime (custom tone or built-in klaxon) + its cache
  // tag. The tag is folded into the key so swapping a tone busts the cache; the
  // built-in tag is OMITTED from the key so default users see zero cache churn.
  const chimeTag = opts.chimeTag ?? BUILTIN_CHIME_TAG;
  const hash = renderCacheKey(level, message, chimeRepeat, leadMs, announceRepeat, repeatGapMs, chimeGapMs, chimeTag);
  const filename = `${hash}.wav`;
  const outPath = resolve(cacheDir, filename);

  // Cache hit short-circuit. v0.20.0 — a single async stat (which yields both
  // existence and size) replaces the prior synchronous existsSync + stat; ENOENT
  // throws into the catch, so the fall-through-to-render behavior is unchanged
  // and the event loop is no longer blocked on the common cache-hit path.
  try {
    const st = await stat(outPath);
    return { ok: true, filename, sizeBytes: st.size, fromCache: true };
  } catch {
    // not cached (or unstattable) → fall through to re-render
  }

  // Load the chime. v0.15.23 — a custom tone (opts.chimePath) overrides the
  // built-in klaxon, but a read failure FALLS BACK to the built-in for the
  // level rather than failing the announcement — a missing/corrupt tone must
  // never silence an alarm on a live power system.
  const builtinPath = resolve(klaxonDir, KLAXON_FOR_LEVEL[level]);
  const klaxonPath = opts.chimePath ?? builtinPath;
  let klaxonWav: Buffer;
  try {
    klaxonWav = await readFile(klaxonPath);
  } catch (e: any) {
    if (opts.chimePath && klaxonPath !== builtinPath) {
      log(`audioRenderer: custom chime unreadable (${e?.message ?? e}) — falling back to built-in klaxon`);
      try {
        klaxonWav = await readFile(builtinPath);
      } catch (e2: any) {
        return { ok: false, error: `klaxon read failed (builtin fallback): ${e2?.message ?? e2}` };
      }
    } else {
      return { ok: false, error: `klaxon read failed: ${e?.message ?? e}` };
    }
  }
  const klaxonHeader = parseWavHeader(klaxonWav);
  if (!klaxonHeader.ok) {
    return { ok: false, error: `klaxon WAV malformed: ${klaxonPath}` };
  }

  // No TTS → klaxon-only path. Cache the klaxon under the hash so the HTTP
  // serving path is uniform. v0.11.0 — repeat the chime N times so a chime-
  // only announcement matches the repeat applied on the chime+TTS path. When
  // N == 1 this is byte-identical to the original klaxon WAV.
  if (!message || message.trim().length === 0) {
    try {
      await mkdir(cacheDir, { recursive: true });
      // v0.12.1 — prepend the lead-in silence and repeat the chime. When
      // leadMs == 0 && chimeRepeat == 1 this is byte-identical to the klaxon WAV.
      const silence = makeSilencePcm(klaxonHeader, leadMs);
      let klaxonOnly = klaxonWav;
      if (silence.length > 0 || chimeRepeat > 1 || announceRepeat > 1) {
        const klaxonPcm = klaxonWav.subarray(klaxonHeader.dataOffset, klaxonHeader.dataOffset + klaxonHeader.dataLength);
        // v0.15.7 — emit announceRepeat blocks of chimeRepeat chimes, with a
        // silence gap between blocks so a repeat is audibly separated. Bounded
        // push-loops (chimeRepeat ≤ MAX_CHIME_REPEAT, announceRepeat ≤ 3) keep
        // this off the resource-exhaustion path.
        const gap = makeSilencePcm(klaxonHeader, repeatGapMs);
        const chimeParts: Buffer[] = [silence];
        for (let r = 0; r < announceRepeat; r++) {
          if (r > 0 && gap.length > 0) chimeParts.push(gap);
          for (let c = 0; c < chimeRepeat; c++) chimeParts.push(klaxonPcm);
        }
        const pcm = Buffer.concat(chimeParts);
        klaxonOnly = pcmToWav(pcm, klaxonHeader.rate, klaxonHeader.width, klaxonHeader.channels);
      }
      await writeFile(outPath, klaxonOnly);
      return { ok: true, filename, sizeBytes: klaxonOnly.length, fromCache: false };
    } catch (e: any) {
      return { ok: false, error: `cache write failed: ${e?.message ?? e}` };
    }
  }

  // v0.57.0 — verbalize the spoken text at the single chokepoint EVERY
  // announcement path converges on: condition broadcasts (buildAlertMessage,
  // already partly normalized — the pass is idempotent), the hand-built
  // SoC/runway alarm strings (batterySocAlarm/runwayAlarm, previously RAW), and
  // the test/preview strings. Units ("6 h" → "6 hours"), math/relational symbols
  // (≥ < ~ — → ²) and abbreviations are now read naturally by Piper instead of
  // letter-by-letter. Done AFTER renderCacheKey (above) so cache keys stay keyed
  // on the raw message and remain stable.
  const spoken = verbalizeForTts(message);

  // Render TTS
  const ttsResult = await renderWyomingTts({
    host: wyomingHost,
    port: wyomingPort,
    text: spoken,
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

  // Concat PCM data, rebuild header. v0.12.1 — a lead-in silence is prepended
  // so speakers can sync before audio; then (v0.11.0) the chime plays chimeRepeat
  // times (default 2) before the spoken TTS, so the operator hears a brief gap,
  // the klaxon twice, then the announcement.
  const klaxonPcm = klaxonWav.subarray(klaxonHeader.dataOffset, klaxonHeader.dataOffset + klaxonHeader.dataLength);
  const ttsPcm = ttsResult.wav.subarray(ttsHeader.dataOffset, ttsHeader.dataOffset + ttsHeader.dataLength);
  const silence = makeSilencePcm(klaxonHeader, leadMs);
  // v0.15.4 — one block = chime×chimeRepeat + the spoken message; the whole block
  // repeats announceRepeat times so a missed first pass gets a second. The lead-in
  // silence stays once, up front. The chime list is built with a bounded push-loop
  // (chimeRepeat is guarded to ≤ MAX_CHIME_REPEAT) rather than Array(n).fill(), to
  // keep it off the resource-exhaustion path — byte-identical to the old form.
  // v0.15.7 — a silence gap (repeatGapMs) is inserted between blocks so the
  // listener can tell the message ended and is repeating.
  // v0.15.15 — a post-chime gap (chimeGapMs, default 1 s) sits between the
  // chime group and the spoken message so the chime fully decays before the
  // announcement begins.
  const block: Buffer[] = [];
  for (let i = 0; i < chimeRepeat; i++) block.push(klaxonPcm);
  const chimeGap = makeSilencePcm(klaxonHeader, chimeGapMs);
  if (chimeGap.length > 0) block.push(chimeGap);
  block.push(ttsPcm);
  const gap = makeSilencePcm(klaxonHeader, repeatGapMs);
  const parts: Buffer[] = [silence];
  for (let i = 0; i < announceRepeat; i++) {
    if (i > 0 && gap.length > 0) parts.push(gap);
    parts.push(...block);
  }
  const combinedPcm = Buffer.concat(parts);
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

/**
 * Hash function exposed for tests so the cache-key format is pinned.
 * v0.11.0 — the chime-repeat count is part of the key (changing it busts the
 * cache). Defaults to the live getChimeRepeat() so callers/tests that don't
 * pass it match what renderAnnouncement() would produce.
 */
export function renderCacheKey(
  level: AnnouncementLevel,
  message: string | null,
  chimeRepeat?: number,
  leadSilenceMs?: number,
  announceRepeat?: number,
  repeatGapMs?: number,
  chimeGapMs?: number,
  chimeTag?: string,
): string {
  // v0.15.4 — same bound as renderAnnouncement so the predicted filename and the
  // rendered audio agree, and so a caller-supplied chimeRepeat can't grow the key
  // space without limit.
  const repeat = Math.max(1, Math.min(MAX_CHIME_REPEAT, Math.round(chimeRepeat ?? getChimeRepeat())));
  // v0.15.4 — announce-repeat (whole chime+message block) is part of the key.
  const annRepeat = Math.max(1, Math.min(3, Math.round(announceRepeat ?? 1)));
  const leadMs = Math.max(0, Math.round(leadSilenceMs ?? 0));
  // v0.15.7 — inter-repeat silence gap is part of the key.
  const gapMs = Math.max(0, Math.round(repeatGapMs ?? 0));
  // v0.15.15 — post-chime silence gap is part of the key.
  const cgMs = Math.max(0, Math.round(chimeGapMs ?? 1000));
  // v0.15.23 — custom-chime identity. The component is OMITTED for the built-in
  // klaxon (BUILTIN_CHIME_TAG) so default users' keys are byte-identical to the
  // pre-feature string (zero cache churn); a custom tone's content id makes the
  // key distinct so swapping a tone re-renders. Applied identically here and at
  // the renderAnnouncement call site (both pass opts.chimeTag ?? BUILTIN_CHIME_TAG).
  const tag = chimeTag ?? BUILTIN_CHIME_TAG;
  // v0.23.0 — for a named/custom tone, also key on AUDIO_ASSETS_VERSION so a
  // future tone-asset regeneration (a builder/envelope change) invalidates the
  // dependent combined render instead of silently serving a stale/clipped clip.
  // The builtin klaxon still OMITS the component (zero cache churn for the
  // default; the RENDER_VERSION bump above already flushes it once).
  const tagPart = tag === BUILTIN_CHIME_TAG ? '' : `|k${tag}|a${AUDIO_ASSETS_VERSION}`;
  return createHash('sha1')
    .update(`v${RENDER_VERSION}|${level}|x${repeat}|r${annRepeat}|s${leadMs}|g${gapMs}|c${cgMs}${tagPart}|${message ?? '<null>'}`)
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
