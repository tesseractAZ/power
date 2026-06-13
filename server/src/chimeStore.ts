/**
 * chimeStore.ts — operator-uploaded alarm tones (v0.15.23 / Alert Console).
 *
 * The operator can upload their own short WAV to PREPEND the spoken alert
 * message in place of the built-in synthesized klaxon (audioAssets.ts). This
 * module owns the on-disk library at /data/chimes:
 *   <id>.wav        — the NORMALIZED tone (always 22050 Hz / 16-bit / mono)
 *   manifest.json   — { [id]: { originalName, sizeBytes, durationMs, srcRate, srcChannels, srcBits, uploadedAt } }
 *
 * Two hard safety rules, both motivated by the fact that this sits on the
 * audible-alert path of a live off-grid home:
 *
 *  1. NORMALIZE ON INGEST. The renderer (audioRenderer.ts) byte-splices the
 *     chime PCM with Piper's TTS PCM and REQUIRES identical rate/width/
 *     channels (audioRenderer.ts ~289-302) — a mismatch makes the whole
 *     announcement fail. Rather than reject the ~99% of real-world files that
 *     are 44.1 kHz stereo, we downmix + linear-resample + requantize ONCE here
 *     to exactly the klaxon format. This is one-time, pure, and unit-tested —
 *     NOT per-render DSP (that path stays a byte-splice).
 *
 *  2. SERVER-GENERATED IDS ONLY. The id is the content hash of the normalized
 *     PCM (16 hex). A client-supplied filename NEVER touches a path or URL — it
 *     lives only in the manifest as a display label. Served basenames match the
 *     same /^[a-f0-9]{16}\.wav$/ strictness the render cache uses.
 *
 * The render path additionally falls back to the built-in klaxon if a custom
 * file is missing/unreadable (see chimeConfig.resolveChime + audioRenderer), so
 * a bad or deleted tone degrades to "wrong tone, message still plays" — never a
 * silent alarm.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { pcmToWav } from './wyomingTts.js';

/** The renderer's fixed PCM format (audioAssets.ts SAMPLE_RATE/BITS/CHANNELS). */
export const TARGET_RATE = 22050;
export const TARGET_WIDTH = 2; // bytes (16-bit)
export const TARGET_CHANNELS = 1;

/** Caps — /data also holds the SQLite DB + audio caches, so bound growth. */
export const MAX_UPLOAD_BYTES = 2_000_000;   // ~2 MB raw upload
export const MAX_CHIME_COUNT = 20;
export const MAX_DURATION_MS = 15_000;       // a prepend tone, not a song

/** Library dir — same base (DATA_DIR) as the audio-render static root so the
 *  /chimes/* preview route and this writer never disagree on location. */
export const CHIMES_DIR = resolve(process.env.CHIMES_DIR ?? process.env.DATA_DIR ?? '/data', 'chimes');
const MANIFEST = resolve(CHIMES_DIR, 'manifest.json');

export interface ChimeMeta {
  id: string;
  originalName: string;
  sizeBytes: number;       // size of the stored (normalized) WAV
  durationMs: number;
  srcRate: number;
  srcChannels: number;
  srcBits: number;
  uploadedAt: number;
}

export interface SaveResult {
  ok: boolean;
  meta?: ChimeMeta;
  error?: string;
}

/* ─── WAV decoding (a superset of audioRenderer.parseWavHeader: also reads the
 *     fmt audio-format tag so we can decode int vs float PCM) ──────────────── */

interface DecodedWav {
  ok: boolean;
  error?: string;
  formatTag: number;   // 1 = PCM int, 3 = IEEE float
  rate: number;
  channels: number;
  bits: number;
  /** Mono Float64 samples in [-1, 1], already downmixed. */
  mono: Float64Array;
}

function decodeWav(buf: Buffer): DecodedWav {
  const fail = (error: string): DecodedWav =>
    ({ ok: false, error, formatTag: 0, rate: 0, channels: 0, bits: 0, mono: new Float64Array(0) });
  if (buf.length < 44) return fail('file too small to be a WAV');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return fail('not a RIFF/WAVE file (only .wav uploads are supported)');
  }
  let cursor = 12;
  let formatTag = 0, channels = 0, rate = 0, bits = 0;
  let fmtFound = false;
  while (cursor + 8 <= buf.length) {
    const id = buf.toString('ascii', cursor, cursor + 4);
    const size = buf.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === 'fmt ' && size >= 16) {
      formatTag = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      fmtFound = true;
    } else if (id === 'data') {
      if (!fmtFound) return fail('malformed WAV (data chunk before fmt)');
      const dataEnd = Math.min(body + size, buf.length);
      const mono = decodeSamples(buf, body, dataEnd, formatTag, channels, bits);
      if (!mono) return fail(`unsupported WAV encoding (format ${formatTag}, ${bits}-bit)`);
      if (rate <= 0 || channels <= 0) return fail('degenerate WAV format');
      return { ok: true, formatTag, rate, channels, bits, mono };
    }
    cursor = body + size + (size % 2); // chunks are word-aligned
  }
  return fail('no data chunk found in WAV');
}

/** Decode interleaved PCM → mono Float64 in [-1,1]. Returns null on an
 *  unsupported encoding. Supports PCM int 8/16/24/32 and IEEE float 32. */
function decodeSamples(
  buf: Buffer, start: number, end: number, formatTag: number, channels: number, bits: number,
): Float64Array | null {
  const bytesPerSample = bits / 8;
  if (channels <= 0 || bytesPerSample <= 0) return null;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor((end - start) / frameBytes);
  const out = new Float64Array(frames);
  const readOne = sampleReader(formatTag, bits);
  if (!readOne) return null;
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = start + f * frameBytes;
    for (let c = 0; c < channels; c++) acc += readOne(buf, base + c * bytesPerSample);
    out[f] = acc / channels; // downmix
  }
  return out;
}

/** Returns a fn reading ONE sample → float [-1,1], or null if unsupported. */
function sampleReader(formatTag: number, bits: number): ((b: Buffer, o: number) => number) | null {
  if (formatTag === 1) {
    if (bits === 8) return (b, o) => (b.readUInt8(o) - 128) / 128;            // 8-bit is UNSIGNED
    if (bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
    if (bits === 24) return (b, o) => {
      const v = b.readUInt8(o) | (b.readUInt8(o + 1) << 8) | (b.readUInt8(o + 2) << 16);
      return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
    };
    if (bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  } else if (formatTag === 3 && bits === 32) {
    return (b, o) => b.readFloatLE(o);
  }
  return null;
}

/** Linear-resample mono [-1,1] from srcRate to TARGET_RATE. */
function resampleMono(mono: Float64Array, srcRate: number): Float64Array {
  if (srcRate === TARGET_RATE || mono.length === 0) return mono;
  const ratio = TARGET_RATE / srcRate;
  const outLen = Math.max(1, Math.floor(mono.length * ratio));
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, mono.length - 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}

/** Float [-1,1] → 16-bit signed PCM Buffer. */
function floatToPcm16(mono: Float64Array): Buffer {
  const out = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    let s = mono[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return out;
}

/**
 * Normalize an arbitrary WAV buffer to a 22050/16/mono WAV Buffer plus its
 * content hash and source metadata. Pure + deterministic — exported for tests.
 */
export function normalizeToTarget(buf: Buffer): { ok: boolean; error?: string; wav?: Buffer; pcm?: Buffer; durationMs?: number; srcRate?: number; srcChannels?: number; srcBits?: number } {
  const dec = decodeWav(buf);
  if (!dec.ok) return { ok: false, error: dec.error };
  const resampled = resampleMono(dec.mono, dec.rate);
  const durationMs = Math.round((resampled.length / TARGET_RATE) * 1000);
  if (durationMs <= 0) return { ok: false, error: 'WAV contains no audio samples' };
  if (durationMs > MAX_DURATION_MS) {
    return { ok: false, error: `tone too long (${(durationMs / 1000).toFixed(1)}s; max ${MAX_DURATION_MS / 1000}s)` };
  }
  const pcm = floatToPcm16(resampled);
  const wav = pcmToWav(pcm, TARGET_RATE, TARGET_WIDTH, TARGET_CHANNELS);
  return { ok: true, wav, pcm, durationMs, srcRate: dec.rate, srcChannels: dec.channels, srcBits: dec.bits };
}

/* ─── manifest ────────────────────────────────────────────────────────────── */

function readManifest(): Record<string, ChimeMeta> {
  // v0.16.2 — NULL-PROTOTYPE object + 16-hex key validation on read. The
  // manifest is keyed by chime ids, some derived from user uploads; a crafted
  // or corrupt key (e.g. "__proto__"/"constructor") can never reach the Object
  // prototype here, and a later `manifest[id] = meta` write is injection-safe
  // (prototype-pollution defense, clears js/remote-property-injection).
  const out: Record<string, ChimeMeta> = Object.create(null);
  try {
    if (existsSync(MANIFEST)) {
      const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (ID_RE.test(k) && v != null && typeof v === 'object') out[k] = v as ChimeMeta;
      }
    }
  } catch { /* corrupt → empty */ }
  return out;
}

function writeManifest(m: Record<string, ChimeMeta>): void {
  mkdirSync(CHIMES_DIR, { recursive: true });
  const tmp = `${MANIFEST}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, MANIFEST);
}

const ID_RE = /^[a-f0-9]{16}$/;

/**
 * Resolve a chime id to its absolute on-disk path — the SINGLE seam every
 * user-supplied id must pass through before touching the filesystem. Two
 * independent guards: (1) the id must be exactly 16 lowercase hex chars
 * (no separators, no `.`, no traversal can survive); (2) the resolved path
 * must still be contained within CHIMES_DIR. The containment check is
 * redundant given (1) but makes the no-escape guarantee explicit and is the
 * form static analysers recognise as a path-injection sanitizer. Returns null
 * for any malformed id or (defensively) any path that would escape the dir.
 */
function chimeFilePath(id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const p = resolve(CHIMES_DIR, `${id}.wav`);
  if (p !== `${CHIMES_DIR}${sep}${id}.wav` || !p.startsWith(CHIMES_DIR + sep)) return null;
  return p;
}

/** A stored chime's absolute path, or null if the id is malformed/absent. */
export function chimePath(id: string): string | null {
  const p = chimeFilePath(id);
  return p && existsSync(p) ? p : null;
}

export function listChimes(): ChimeMeta[] {
  const m = readManifest();
  // Only surface entries whose file actually exists (self-heal after manual deletes).
  return Object.values(m)
    .filter((c) => existsSync(resolve(CHIMES_DIR, `${c.id}.wav`)))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export function chimeExists(id: string): boolean {
  return chimePath(id) != null;
}

/**
 * Validate, normalize, and store an uploaded WAV. Content-addressed: the id is
 * the sha1 of the normalized PCM (so a re-upload de-dupes). nowMs is injectable
 * for tests.
 */
export function saveChime(buf: Buffer, originalName: string, nowMs = Date.now()): SaveResult {
  if (buf.length === 0) return { ok: false, error: 'empty upload' };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `file too large (${(buf.length / 1e6).toFixed(1)} MB; max ${MAX_UPLOAD_BYTES / 1e6} MB)` };
  }
  const norm = normalizeToTarget(buf);
  if (!norm.ok || !norm.wav || !norm.pcm) return { ok: false, error: norm.error ?? 'normalization failed' };

  // id is the content hash (always 16 hex chars) — route it through the SAME
  // guarded resolver as user-supplied ids so every write path is uniform.
  const id = createHash('sha1').update(norm.pcm).digest('hex').slice(0, 16);
  const path = chimeFilePath(id);
  if (path == null) return { ok: false, error: 'internal: bad chime id' };
  const manifest = readManifest();
  const existing = manifest[id] != null && existsSync(path);
  if (!existing && listChimes().length >= MAX_CHIME_COUNT) {
    return { ok: false, error: `library full (max ${MAX_CHIME_COUNT} tones) — delete one first` };
  }

  const cleanName = sanitizeName(originalName);
  const meta: ChimeMeta = {
    id,
    originalName: cleanName,
    sizeBytes: norm.wav.length,
    durationMs: norm.durationMs ?? 0,
    srcRate: norm.srcRate ?? 0,
    srcChannels: norm.srcChannels ?? 0,
    srcBits: norm.srcBits ?? 0,
    uploadedAt: nowMs,
  };
  try {
    mkdirSync(CHIMES_DIR, { recursive: true });
    const path = resolve(CHIMES_DIR, `${id}.wav`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, norm.wav);
    renameSync(tmp, path);
    manifest[id] = meta;
    writeManifest(manifest);
  } catch (e: any) {
    return { ok: false, error: `store failed: ${e?.message ?? e}` };
  }
  return { ok: true, meta };
}

/** Delete a stored chime + its manifest entry. Returns true if anything removed. */
export function deleteChime(id: string): boolean {
  const path = chimeFilePath(id);
  if (path == null) return false; // malformed/traversal id — nothing to delete
  let removed = false;
  if (existsSync(path)) { try { rmSync(path); removed = true; } catch { /* ignore */ } }
  const manifest = readManifest();
  if (manifest[id] != null) { delete manifest[id]; writeManifest(manifest); removed = true; }
  return removed;
}

/** Display-only filename: strip path separators and clamp length. NEVER a path. */
function sanitizeName(name: string): string {
  const base = (name || 'tone.wav').replace(/[/\\]/g, '_').replace(/[^\w.\- ]/g, '').trim();
  return (base.length ? base : 'tone.wav').slice(0, 80);
}

/** Test seam — total bytes used by the library. */
export function libraryBytes(): number {
  if (!existsSync(CHIMES_DIR)) return 0;
  let total = 0;
  for (const f of readdirSync(CHIMES_DIR)) {
    if (f.endsWith('.wav')) { try { total += statSync(resolve(CHIMES_DIR, f)).size; } catch { /* race */ } }
  }
  return total;
}
