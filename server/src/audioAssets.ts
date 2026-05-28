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
  kind: 'square' | 'sine' | 'bell';
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
  /** v0.9.70 — bell-tone harmonic mix. Defaults to [1, 0.5, 0.25, 0.125]
   * (fundamental + 2x + 3x + 4x with halving amplitudes — the canonical
   * struck-bell timbre). Override with [1] for a pure sine, or [1, 0.4]
   * for a softer "phone chime" tone. Only applies when kind='bell'. */
  harmonics?: number[];
  /** v0.9.70 — exponential decay constant (smaller = faster decay). For
   * 'bell' kind, this controls the strike-decay shape. Defaults to
   * durSec * 0.55 — longer than the v0.9.18 0.35 to give an airport-PA
   * "ring out" feel instead of a sharp attack-and-die. */
  decaySec?: number;
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
  const decaySec = t.decaySec ?? (t.durSec * 0.55);
  // v0.9.70 — bell harmonics (additive synthesis for proper struck-bell timbre)
  const harmonics = t.harmonics ?? [1.0, 0.5, 0.25, 0.125];

  for (let i = startSample, k = 0; i < endSample; i++, k++) {
    // Frequency for this sample (linear glide if endFreq differs).
    const frac = k / totalSamples;
    const f = t.endFreq != null ? t.freq + (t.endFreq - t.freq) * frac : t.freq;
    const tSec = k / SAMPLE_RATE;

    // Gain envelope.
    let env: number;
    if (t.bellDecay || t.kind === 'bell') {
      // Sharp attack + exponential decay (e^-k·t). v0.9.70 longer decay
      // (default 0.55*dur vs old 0.35) for an airport-PA ring-out.
      env = t.gain * (1 - Math.exp(-tSec / 0.005)) * Math.exp(-tSec / decaySec);
    } else if (k < attackSamples) {
      env = t.gain * (k / attackSamples);
    } else if (k > totalSamples - releaseSamples) {
      env = t.gain * Math.max(0, (totalSamples - k) / releaseSamples);
    } else {
      env = t.gain;
    }

    // Waveform.
    let sample: number;
    if (t.kind === 'square') {
      // Square wave via phase modulo (no harmonics)
      const phase = 2 * Math.PI * f * tSec;
      sample = phase % (2 * Math.PI) < Math.PI ? 1 : -1;
    } else if (t.kind === 'bell') {
      // v0.9.70 — additive bell. Sum of sines at integer multiples of
      // the fundamental, each scaled by its harmonic gain. The mix in
      // `harmonics` defines the timbre (default = canonical struck bell:
      // fundamental + 2nd + 3rd + 4th at 1.0 / 0.5 / 0.25 / 0.125).
      let s = 0;
      let weightSum = 0;
      for (let h = 0; h < harmonics.length; h++) {
        const hGain = harmonics[h];
        if (hGain === 0) continue;
        s += hGain * Math.sin(2 * Math.PI * f * (h + 1) * tSec);
        weightSum += hGain;
      }
      sample = weightSum > 0 ? s / weightSum : 0;
    } else {
      // Pure sine
      sample = Math.sin(2 * Math.PI * f * tSec);
    }
    buf[i] += sample * env;
  }
}

/* ─── asset definitions ───────────────────────────────────────────── */

/**
 * Red Alert — v0.9.70 airport-PA "attention now" chime.
 *
 * Three-note descending struck-bell arpeggio (C5 → A4 → F4 — a Am
 * descending triad), repeated once after a brief gap. Bell timbre via
 * additive harmonics. The descending minor-flavor pattern conveys
 * seriousness without the abrasive square-wave urgency of the old TMP
 * klaxon. Two iterations total ensures the listener catches it even if
 * distracted on the first ring.
 *
 * Designed to feel like "ladies and gentlemen, the captain has turned
 * on the seatbelt sign" — calm but firm. Same forward energy as a BART
 * 3-note arrival tone, just with a heavier descending pattern to signal
 * "this needs your attention" instead of "your stop is next."
 *
 * Total ~3.0 sec, comfortably below the 5-sec settle window MA needs
 * between back-to-back play_announcement calls.
 */
function redAlertSegments(): { segs: Segment[]; totalSec: number } {
  const segs: Segment[] = [];
  // C5, A4, F4 — Am descending arpeggio
  const notes = [
    { freq: 523.25, gain: 0.55 },
    { freq: 440.00, gain: 0.55 },
    { freq: 349.23, gain: 0.55 },
  ];
  const noteDur = 0.42;
  const noteStep = 0.32;       // notes overlap slightly for legato feel
  const iterations = 2;
  const iterGap = 0.45;        // gap between full arpeggio iterations
  const iterDur = notes.length * noteStep + (noteDur - noteStep);
  for (let it = 0; it < iterations; it++) {
    const itOffset = it * (iterDur + iterGap);
    notes.forEach((n, idx) => {
      segs.push({
        startSec: itOffset + idx * noteStep,
        spec: {
          kind: 'bell',
          freq: n.freq,
          durSec: noteDur,
          gain: n.gain,
          decaySec: 0.55,
          // Airport-PA "fuller" bell with strong 2nd harmonic.
          harmonics: [1.0, 0.55, 0.30, 0.15],
        },
      });
    });
  }
  const totalSec = iterations * iterDur + (iterations - 1) * iterGap + 0.5;
  return { segs, totalSec };
}

/**
 * Yellow Alert — v0.9.70 classic two-note PA "bing-bong" chime.
 *
 * Descending major 3rd (E5 → C5) with bell timbre. The pattern most
 * people associate with "next, an announcement" — public-address tone
 * that gets attention without urgency. Single iteration; this is a
 * notice, not an alarm.
 *
 * Slight overlap on the two notes for that bound-together "bing-bong"
 * feel rather than two distinct pings.
 */
function yellowAlertSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'bell', freq: 659.25, durSec: 0.50, gain: 0.55, decaySec: 0.50, harmonics: [1.0, 0.45, 0.20] } }, // E5
      { startSec: 0.32, spec: { kind: 'bell', freq: 523.25, durSec: 0.85, gain: 0.55, decaySec: 0.65, harmonics: [1.0, 0.45, 0.20] } }, // C5
    ],
    totalSec: 1.4,
  };
}

/**
 * All Clear — v0.9.70 ascending C-major arpeggio resolution.
 *
 * Three-note rising major triad (C5 → E5 → G5). Bright, positive,
 * resolves the tension of a prior alert. Bell timbre matches the other
 * alerts for a consistent sonic family.
 */
function allClearSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'bell', freq: 523.25, durSec: 0.35, gain: 0.50, decaySec: 0.45, harmonics: [1.0, 0.40, 0.20] } }, // C5
      { startSec: 0.22, spec: { kind: 'bell', freq: 659.25, durSec: 0.35, gain: 0.50, decaySec: 0.45, harmonics: [1.0, 0.40, 0.20] } }, // E5
      { startSec: 0.44, spec: { kind: 'bell', freq: 783.99, durSec: 0.70, gain: 0.50, decaySec: 0.60, harmonics: [1.0, 0.40, 0.20] } }, // G5
    ],
    totalSec: 1.3,
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

/**
 * v0.9.70 — bumped from 1 (the implicit version of all v0.9.18-v0.9.69
 * synthesis) to 2 when the airport-style chimes replaced the TMP square
 * waves + sine bells. The marker file at `${outDir}/.assets-version`
 * stores the version that produced the WAVs on disk; if it doesn't
 * match this constant, generateAudioAssets() force-regenerates so the
 * new tones reach the speakers without manual `/data/audio` cleanup.
 *
 * Bump this whenever a synthesis param changes (frequencies, envelopes,
 * harmonics, timings). The cache is per-version so old WAVs are
 * replaced atomically rather than coexisting.
 */
export const AUDIO_ASSETS_VERSION = 2;

/** Write all assets to `outDir`. Regenerates if the on-disk version is stale. */
export async function generateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }
  // v0.9.70 — version-gated regeneration. Read the marker; if it doesn't
  // match, treat every existing WAV as stale.
  const versionMarker = resolve(outDir, '.assets-version');
  let onDiskVersion = 0;
  if (existsSync(versionMarker)) {
    try {
      const { readFile } = await import('node:fs/promises');
      onDiskVersion = parseInt((await readFile(versionMarker, 'utf8')).trim(), 10) || 0;
    } catch { /* ignore — treat as version 0 */ }
  }
  const stale = onDiskVersion !== AUDIO_ASSETS_VERSION;
  if (stale && onDiskVersion > 0) {
    log(`audioAssets: version ${onDiskVersion} on disk, regenerating for v${AUDIO_ASSETS_VERSION}`);
  }
  const defs: Record<AudioAssetId, () => { segs: Segment[]; totalSec: number }> = {
    'red-alert':    redAlertSegments,
    'yellow-alert': yellowAlertSegments,
    'all-clear':    allClearSegments,
    'boatswain':    boatswainSegments,
  };
  for (const id of AUDIO_ASSETS) {
    const path = resolve(outDir, `${id}.wav`);
    if (!stale && existsSync(path)) continue;
    const { segs, totalSec } = defs[id]();
    const samples = renderSegments(segs, totalSec);
    const wav = buildWavBuffer(samples);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, wav);
    log(`audioAssets: wrote ${id}.wav (${(wav.length / 1024).toFixed(1)} KB, ${totalSec.toFixed(2)} s)`);
  }
  if (stale) {
    await writeFile(versionMarker, String(AUDIO_ASSETS_VERSION) + '\n');
  } else if (!existsSync(versionMarker)) {
    // First-ever generation — record version so future bumps detect change.
    await writeFile(versionMarker, String(AUDIO_ASSETS_VERSION) + '\n');
  }
}

/** Force-regenerate (used by tests / explicit "reset audio" trigger). */
export async function regenerateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  for (const id of AUDIO_ASSETS) {
    const path = resolve(outDir, `${id}.wav`);
    if (existsSync(path)) await unlink(path);
  }
  const versionMarker = resolve(outDir, '.assets-version');
  if (existsSync(versionMarker)) await unlink(versionMarker);
  return generateAudioAssets(outDir, log);
}
