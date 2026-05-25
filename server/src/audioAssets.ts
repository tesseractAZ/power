/**
 * v0.9.18 — server-side WAV synthesis for ship-wide audible broadcasts.
 *
 * The Starfleet web UI plays TMP-era alert sounds via the Web Audio API
 * (good for the operator at the screen). But operators are not always
 * at their station — so we also need to push the same sounds to
 * HomePods + Sonos throughout the property.
 *
 * Speakers can't synthesize on the fly; they need URLs to stream. This
 * module synthesizes the sound assets ONCE at server startup, writes
 * them to /data/audio/, and the Fastify server exposes them via a
 * static route. Home Assistant's `media_player.play_media` service
 * then tells each Sonos / HomePod to stream the right URL.
 *
 * The synthesis parameters match `web/src/starfleet/sound.ts` so the
 * speaker audio matches what the operator hears in the browser.
 *
 * WAV format: PCM, 16-bit signed little-endian, 22050 Hz mono. Most
 * Sonos + HomePod firmwares stream this without resampling artifacts;
 * 22 kHz is plenty for square-wave klaxons + sine bell tones, and the
 * file size stays modest (~88 KB for a 2 s clip).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/* ─── WAV writer ──────────────────────────────────────────────────── */

const SAMPLE_RATE = 22050;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/** Build the 44-byte WAV header + return a Buffer ready to write. */
function buildWavBuffer(samples: Int16Array): Buffer {
  const dataLen = samples.length * 2; // 2 bytes per sample
  const buf = Buffer.alloc(44 + dataLen);
  let o = 0;
  // RIFF header
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(36 + dataLen, o); o += 4;
  buf.write('WAVE', o); o += 4;
  // fmt chunk
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;                                       // chunk size
  buf.writeUInt16LE(1, o); o += 2;                                        // PCM
  buf.writeUInt16LE(NUM_CHANNELS, o); o += 2;
  buf.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE / 8, o); o += 4; // byte rate
  buf.writeUInt16LE(NUM_CHANNELS * BITS_PER_SAMPLE / 8, o); o += 2;       // block align
  buf.writeUInt16LE(BITS_PER_SAMPLE, o); o += 2;
  // data chunk
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataLen, o); o += 4;
  // PCM samples
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

/* ─── synth primitives ────────────────────────────────────────────── */

interface ToneSpec {
  kind: 'square' | 'sine';
  /** Hertz. */
  freq: number;
  /** Frequency at end of segment (for glides). Defaults to `freq`. */
  endFreq?: number;
  /** Segment length in seconds. */
  durSec: number;
  /** Gain at sustain, 0..1. */
  gain: number;
  /** Linear ramp-in length in seconds. */
  attackSec?: number;
  /** Linear ramp-out length in seconds. */
  releaseSec?: number;
  /** Exponential decay across the segment (for bell tones). */
  bellDecay?: boolean;
}

interface Segment {
  /** Start offset in seconds from beginning of asset. */
  startSec: number;
  spec: ToneSpec;
}

function renderSegments(segs: Segment[], totalSec: number): Int16Array {
  const totalSamples = Math.ceil(totalSec * SAMPLE_RATE);
  const buf = new Float32Array(totalSamples);
  for (const seg of segs) {
    addTone(buf, seg.startSec, seg.spec);
  }
  // Convert float [-1, 1] → int16 with mild headroom.
  const out = new Int16Array(totalSamples);
  const peak = 32760;
  for (let i = 0; i < totalSamples; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    out[i] = Math.round(v * peak);
  }
  return out;
}

function addTone(buf: Float32Array, startSec: number, t: ToneSpec): void {
  const attack = t.attackSec ?? 0.005;
  const release = t.releaseSec ?? 0.02;
  const startSample = Math.floor(startSec * SAMPLE_RATE);
  const totalSamples = Math.floor(t.durSec * SAMPLE_RATE);
  const endSample = Math.min(buf.length, startSample + totalSamples);
  const attackSamples = Math.floor(attack * SAMPLE_RATE);
  const releaseSamples = Math.floor(release * SAMPLE_RATE);

  let phase = 0;
  for (let i = startSample, k = 0; i < endSample; i++, k++) {
    // Frequency for this sample (linear glide if endFreq differs).
    const frac = k / totalSamples;
    const f = t.endFreq != null ? t.freq + (t.endFreq - t.freq) * frac : t.freq;
    const dPhase = (2 * Math.PI * f) / SAMPLE_RATE;
    phase += dPhase;

    // Gain envelope.
    let env: number;
    if (t.bellDecay) {
      // Sharp attack + exponential decay (e^-k·t).
      const tSec = k / SAMPLE_RATE;
      env = t.gain * (1 - Math.exp(-tSec / 0.005)) * Math.exp(-tSec / (t.durSec * 0.35));
    } else if (k < attackSamples) {
      env = t.gain * (k / attackSamples);
    } else if (k > totalSamples - releaseSamples) {
      env = t.gain * Math.max(0, (totalSamples - k) / releaseSamples);
    } else {
      env = t.gain;
    }

    // Waveform.
    const sample = t.kind === 'square'
      ? (phase % (2 * Math.PI) < Math.PI ? 1 : -1)
      : Math.sin(phase);
    buf[i] += sample * env;
  }
}

/* ─── asset definitions ───────────────────────────────────────────── */

/**
 * Red Alert — TMP klaxon. Two-tone square wave alternating between
 * 440 Hz / 660 Hz at 250 ms each, 6 cycles total (3 seconds). Higher
 * cycle count than the in-browser version because speakers are usually
 * further from the listener; we want to be confident the user heard it.
 */
function redAlertSegments(): { segs: Segment[]; totalSec: number } {
  const segs: Segment[] = [];
  const stepSec = 0.25;
  const cycles = 6;
  for (let i = 0; i < cycles; i++) {
    const t = i * 2 * stepSec;
    segs.push({ startSec: t,            spec: { kind: 'square', freq: 440, durSec: stepSec, gain: 0.55, attackSec: 0.003, releaseSec: 0.006 } });
    segs.push({ startSec: t + stepSec,  spec: { kind: 'square', freq: 660, durSec: stepSec, gain: 0.55, attackSec: 0.003, releaseSec: 0.006 } });
  }
  return { segs, totalSec: cycles * 2 * stepSec + 0.1 };
}

/**
 * Yellow Alert — descending two-tone bell. Sine waves with exponential
 * decay, 880 → 660 Hz. Single ring (no cycle).
 */
function yellowAlertSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'sine', freq: 880, durSec: 0.45, gain: 0.55, bellDecay: true } },
      { startSec: 0.25, spec: { kind: 'sine', freq: 660, durSec: 0.80, gain: 0.55, bellDecay: true } },
    ],
    totalSec: 1.2,
  };
}

/**
 * All Clear — three-tone ascending sweep, A4 → D5 → A5. Calm + positive.
 */
function allClearSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'sine', freq: 440, durSec: 0.30, gain: 0.45, bellDecay: true } },
      { startSec: 0.16, spec: { kind: 'sine', freq: 587, durSec: 0.30, gain: 0.45, bellDecay: true } },
      { startSec: 0.32, spec: { kind: 'sine', freq: 880, durSec: 0.55, gain: 0.45, bellDecay: true } },
    ],
    totalSec: 1.0,
  };
}

/**
 * Boatswain whistle — the classic Starfleet shipwide-announcement chime
 * that PRECEDES any verbal address ("Captain to the bridge"). Two-tone
 * pure sine sweep up, hold, then down.
 */
function boatswainSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'sine', freq: 660, endFreq: 1320, durSec: 0.35, gain: 0.35 } },
      { startSec: 0.35, spec: { kind: 'sine', freq: 1320,                 durSec: 0.50, gain: 0.35 } },
      { startSec: 0.85, spec: { kind: 'sine', freq: 1320, endFreq: 660,  durSec: 0.40, gain: 0.35 } },
    ],
    totalSec: 1.4,
  };
}

/* ─── public API ──────────────────────────────────────────────────── */

export const AUDIO_ASSETS = ['red-alert', 'yellow-alert', 'all-clear', 'boatswain'] as const;
export type AudioAssetId = (typeof AUDIO_ASSETS)[number];

/** Write all assets to `outDir`. Idempotent — only writes files that don't already exist. */
export async function generateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }
  const defs: Record<AudioAssetId, () => { segs: Segment[]; totalSec: number }> = {
    'red-alert':    redAlertSegments,
    'yellow-alert': yellowAlertSegments,
    'all-clear':    allClearSegments,
    'boatswain':    boatswainSegments,
  };
  for (const id of AUDIO_ASSETS) {
    const path = resolve(outDir, `${id}.wav`);
    if (existsSync(path)) continue;
    const { segs, totalSec } = defs[id]();
    const samples = renderSegments(segs, totalSec);
    const wav = buildWavBuffer(samples);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, wav);
    log(`audioAssets: wrote ${id}.wav (${(wav.length / 1024).toFixed(1)} KB, ${totalSec.toFixed(2)} s)`);
  }
}

/** Force-regenerate (used when synthesis params change between versions). */
export async function regenerateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  for (const id of AUDIO_ASSETS) {
    const path = resolve(outDir, `${id}.wav`);
    if (existsSync(path)) {
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
    }
  }
  return generateAudioAssets(outDir, log);
}
