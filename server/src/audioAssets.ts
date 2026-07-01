/**
 * v0.9.18 — server-side WAV synthesis for ship-wide audible broadcasts.
 *
 * Alert annunciations (klaxons + the boatswain chime) need to reach
 * operators who aren't sitting at the dashboard — so we push the sounds to
 * HomePods + Sonos throughout the property.
 *
 * Speakers can't synthesize on the fly; they need URLs to stream. This
 * module synthesizes the sound assets ONCE at server startup, writes
 * them to /data/audio/, and the Fastify server exposes them via a
 * static route. Home Assistant's `media_player.play_media` service
 * then tells each Sonos / HomePod to stream the right URL.
 *
 * WAV format: PCM, 16-bit signed little-endian, 22050 Hz mono. Most
 * Sonos + HomePod firmwares stream this without resampling artifacts;
 * 22 kHz is plenty for square-wave klaxons + sine bell tones, and the
 * file size stays modest (~88 KB for a 2 s clip).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

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
  // v0.23.0 — floor the attack so a tone never jumps to full scale on sample 0.
  // A zero-attack square/sine (e.g. 'buzz-alarm', attackSec:0) produced a hard
  // 0→peak DC step — an audible click that read as a "clipped" tone start once
  // the v0.17.0 short named tones became selectable per level. A ~4 ms ramp is
  // still percussively sharp but removes the discontinuity. (Bells use their own
  // exponential attack in the envelope below and are unaffected by this floor.)
  const attack = Math.max(0.004, t.attackSec ?? 0.005);
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
 * Boatswain whistle — the classic shipwide-announcement chime
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

/* ─── v0.13.0/power-plant pack — industrial annunciator tones ──────────
 *
 * The "airport" pack above (melodic struck-bell arpeggios) is friendly but
 * does NOT follow process/power-plant alarm conventions, where priority is
 * conveyed by CADENCE as much as pitch (ISA-18.2 / EEMUA-191): a continuous
 * fast warble = emergency, a slow pulse = caution, a single soft chime =
 * advisory. This pack implements that 3-tier annunciator language so the
 * operator can identify severity by ear without looking. Selected via the
 * BROADCAST_CHIME_PACK option (default "powerplant").
 *
 * Mapping to the existing klaxon levels (red/yellow/green from
 * klaxonLevelForPriority): red = Critical/High emergency, yellow = Medium
 * caution, green = Low advisory / return-to-normal.
 */

/** Critical/High — general-emergency electronic siren: fast hi/lo square
 *  warble (~4 alternations/sec), penetrating, ~2.6 s. "Drop everything." */
function ppRedAlertSegments(): { segs: Segment[]; totalSec: number } {
  const segs: Segment[] = [];
  const hi = 880, lo = 587, seg = 0.12;
  const n = Math.round(2.64 / seg);
  for (let i = 0; i < n; i++) {
    segs.push({
      startSec: i * seg,
      spec: { kind: 'square', freq: i % 2 ? lo : hi, durSec: seg + 0.01, gain: 0.45, attackSec: 0.004, releaseSec: 0.004 },
    });
  }
  return { segs, totalSec: n * seg + 0.12 };
}

/** Medium — caution: slow intermittent single tone (~1.5 Hz), softer sine,
 *  620 Hz, 3 beeps, ~1.9 s. Clearly a notice, not an emergency. */
function ppYellowAlertSegments(): { segs: Segment[]; totalSec: number } {
  const segs: Segment[] = [];
  const on = 0.20, period = 0.62, n = 3;
  for (let i = 0; i < n; i++) {
    segs.push({ startSec: i * period, spec: { kind: 'sine', freq: 620, durSec: on, gain: 0.5, attackSec: 0.01, releaseSec: 0.05 } });
  }
  return { segs, totalSec: (n - 1) * period + on + 0.4 };
}

/** Low / return-to-normal — advisory: soft descending bell double-chime
 *  (~660→554 Hz minor third), gentle, ~1.0 s. Subdued "for awareness". */
function ppAllClearSegments(): { segs: Segment[]; totalSec: number } {
  return {
    segs: [
      { startSec: 0.00, spec: { kind: 'bell', freq: 659.25, durSec: 0.32, gain: 0.4, decaySec: 0.4, harmonics: [1, 0.4, 0.15] } },
      { startSec: 0.26, spec: { kind: 'bell', freq: 554.37, durSec: 0.55, gain: 0.4, decaySec: 0.55, harmonics: [1, 0.4, 0.15] } },
    ],
    totalSec: 1.0,
  };
}

/* ─── v0.17.0 named built-in tone library ──────────────────────────────
 *
 * A fixed library of short, distinct, SELECTABLE chime tones (separate from
 * the 4 level klaxons above). The operator can assign any of these to a level
 * via the Alert Console ({ kind: 'named', id } in chimeConfig). They are
 * SYNTHESIZED ONCE at startup into /data/audio/<id>.wav (same 22050/16/mono
 * format as the klaxons, so the render byte-splice is unaffected) and served
 * for preview by the existing wildcard:false /audio/ static route — they're
 * written before that route enumerates at registration.
 *
 * IMMUTABILITY CONTRACT: a tone id is a permanent identity for one sound. The
 * render-cache tag for a named tone is `b:<id>` (see chimeConfig.resolveChime),
 * which has NO version component — so to CHANGE a sound, ship a NEW id and
 * deprecate the old one; never edit an existing builder's waveform in place
 * (that would serve stale cached renders). Adding/removing tones is fine.
 *
 * These tones are PACK-INDEPENDENT (unlike the 4 klaxons, whose bytes vary with
 * BROADCAST_CHIME_PACK): their synthesis is fixed, which keeps `b:<id>` a
 * correct cache tag regardless of the active pack.
 */

const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99;
const C6 = 1046.5, E6 = 1318.5;

const NAMED_TONE_BUILDERS: Record<string, () => { segs: Segment[]; totalSec: number }> = {
  // Single struck-bell ping — bright, brief acknowledgement.
  'ping-single': () => ({
    segs: [{ startSec: 0, spec: { kind: 'bell', freq: C6, durSec: 0.42, gain: 0.55, decaySec: 0.35, harmonics: [1, 0.4] } }],
    totalSec: 0.55,
  }),
  // Two quick high pings.
  'ping-double': () => ({
    segs: [
      { startSec: 0.00, spec: { kind: 'bell', freq: E6, durSec: 0.28, gain: 0.5, decaySec: 0.22, harmonics: [1, 0.3] } },
      { startSec: 0.18, spec: { kind: 'bell', freq: E6, durSec: 0.30, gain: 0.5, decaySec: 0.24, harmonics: [1, 0.3] } },
    ],
    totalSec: 0.6,
  }),
  // Full C-major triad struck together — a warm chord.
  'triad-bell': () => ({
    segs: [
      { startSec: 0, spec: { kind: 'bell', freq: C5, durSec: 0.85, gain: 0.30, decaySec: 0.6, harmonics: [1, 0.4, 0.2] } },
      { startSec: 0, spec: { kind: 'bell', freq: E5, durSec: 0.85, gain: 0.30, decaySec: 0.6, harmonics: [1, 0.4, 0.2] } },
      { startSec: 0, spec: { kind: 'bell', freq: G5, durSec: 0.85, gain: 0.30, decaySec: 0.6, harmonics: [1, 0.4, 0.2] } },
    ],
    totalSec: 0.95,
  }),
  // Rising chirp — quick upward sine glide.
  'chirp-rise': () => ({
    segs: [{ startSec: 0, spec: { kind: 'sine', freq: 500, endFreq: 1500, durSec: 0.35, gain: 0.5, attackSec: 0.01, releaseSec: 0.05 } }],
    totalSec: 0.45,
  }),
  // Descending sweep — downward sine glide.
  'sweep-down': () => ({
    segs: [{ startSec: 0, spec: { kind: 'sine', freq: 1400, endFreq: 400, durSec: 0.5, gain: 0.5, attackSec: 0.01, releaseSec: 0.05 } }],
    totalSec: 0.6,
  }),
  // Fast warble — urgent emergency-style two-tone square alternation.
  'warble-fast': () => {
    const segs: Segment[] = [];
    const a = 1000, b = 1320, seg = 0.08, n = 6;
    for (let i = 0; i < n; i++) {
      segs.push({ startSec: i * seg, spec: { kind: 'square', freq: i % 2 ? b : a, durSec: seg + 0.005, gain: 0.4, attackSec: 0.003, releaseSec: 0.003 } });
    }
    return { segs, totalSec: n * seg + 0.06 };
  },
  // Slow pulse — two measured caution beeps.
  'pulse-slow': () => {
    const segs: Segment[] = [];
    const on = 0.18, period = 0.45, n = 2;
    for (let i = 0; i < n; i++) {
      segs.push({ startSec: i * period, spec: { kind: 'sine', freq: 700, durSec: on, gain: 0.5, attackSec: 0.01, releaseSec: 0.05 } });
    }
    return { segs, totalSec: (n - 1) * period + on + 0.1 };
  },
  // Soft knock — two muted low taps.
  'knock-soft': () => ({
    segs: [
      { startSec: 0.00, spec: { kind: 'square', freq: 180, durSec: 0.05, gain: 0.4, attackSec: 0.002, releaseSec: 0.03 } },
      { startSec: 0.14, spec: { kind: 'square', freq: 180, durSec: 0.05, gain: 0.4, attackSec: 0.002, releaseSec: 0.03 } },
    ],
    totalSec: 0.3,
  }),
  // Marimba run — four woody ascending struck notes.
  'marimba-run': () => {
    const notes = [C5, D5, E5, G5];
    const step = 0.10;
    return {
      segs: notes.map((f, i) => ({ startSec: i * step, spec: { kind: 'bell' as const, freq: f, durSec: 0.25, gain: 0.5, decaySec: 0.18, harmonics: [1, 0.25] } })),
      totalSec: (notes.length - 1) * step + 0.35,
    };
  },
  // Gong — deep, long, slow-decaying low bell.
  'gong': () => ({
    segs: [{ startSec: 0, spec: { kind: 'bell', freq: 130.8, durSec: 1.2, gain: 0.6, decaySec: 0.9, harmonics: [1, 0.6, 0.4, 0.3, 0.2] } }],
    totalSec: 1.3,
  }),
  // Sonar ping — single tone with a long exponential ring-out and slight droop.
  'sonar-ping': () => ({
    segs: [{ startSec: 0, spec: { kind: 'sine', freq: 1200, endFreq: 1180, durSec: 0.5, gain: 0.5, bellDecay: true, decaySec: 0.4 } }],
    totalSec: 0.6,
  }),
  // Alarm buzz — harsh sustained square, no soft edges.
  'buzz-alarm': () => ({
    segs: [{ startSec: 0, spec: { kind: 'square', freq: 440, durSec: 0.5, gain: 0.45, attackSec: 0, releaseSec: 0.01 } }],
    totalSec: 0.6,
  }),
  // Chime cascade — five descending struck bells.
  'cascade': () => {
    const notes = [G5, F5, E5, D5, C5];
    const step = 0.08;
    return {
      segs: notes.map((f, i) => ({ startSec: i * step, spec: { kind: 'bell' as const, freq: f, durSec: 0.3, gain: 0.45, decaySec: 0.24, harmonics: [1, 0.35] } })),
      totalSec: (notes.length - 1) * step + 0.4,
    };
  },
  // Two-tone doorbell — the classic "ding-dong".
  'doorbell': () => ({
    segs: [
      { startSec: 0.00, spec: { kind: 'bell', freq: E5, durSec: 0.5, gain: 0.5, decaySec: 0.4, harmonics: [1, 0.4] } },
      { startSec: 0.30, spec: { kind: 'bell', freq: C5, durSec: 0.7, gain: 0.5, decaySec: 0.55, harmonics: [1, 0.4] } },
    ],
    totalSec: 1.1,
  }),
  // Klaxon honk — two short low square honks.
  'klaxon-honk': () => ({
    segs: [
      { startSec: 0.00, spec: { kind: 'square', freq: 350, durSec: 0.22, gain: 0.45, attackSec: 0.005, releaseSec: 0.02 } },
      { startSec: 0.30, spec: { kind: 'square', freq: 350, durSec: 0.22, gain: 0.45, attackSec: 0.005, releaseSec: 0.02 } },
    ],
    totalSec: 0.6,
  }),
  // Rising triad — three ascending struck notes resolving upward.
  'triad-up': () => {
    const notes = [C5, E5, G5];
    const step = 0.12;
    return {
      segs: notes.map((f, i) => ({ startSec: i * step, spec: { kind: 'bell' as const, freq: f, durSec: 0.32, gain: 0.45, decaySec: 0.28, harmonics: [1, 0.3] } })),
      totalSec: (notes.length - 1) * step + 0.4,
    };
  },
};

/** One selectable built-in tone (id is permanent; displayName feeds the UI dropdown). */
export interface BuiltinTone { id: string; displayName: string }

/**
 * The named built-in tone catalog — the single source of truth for which tones
 * exist, their display names, and the order shown in the dropdown. Keys MUST
 * match NAMED_TONE_BUILDERS exactly (asserted at startup). Ids are permanent
 * (see the immutability contract above).
 */
export const BUILTIN_TONES: readonly BuiltinTone[] = [
  { id: 'ping-single', displayName: 'Single Ping' },
  { id: 'ping-double', displayName: 'Double Ping' },
  { id: 'triad-bell', displayName: 'Triad Bell' },
  { id: 'triad-up', displayName: 'Rising Triad' },
  { id: 'marimba-run', displayName: 'Marimba Run' },
  { id: 'cascade', displayName: 'Chime Cascade' },
  { id: 'doorbell', displayName: 'Two-Tone Doorbell' },
  { id: 'chirp-rise', displayName: 'Rising Chirp' },
  { id: 'sweep-down', displayName: 'Descending Sweep' },
  { id: 'sonar-ping', displayName: 'Sonar Ping' },
  { id: 'pulse-slow', displayName: 'Slow Pulse (caution)' },
  { id: 'warble-fast', displayName: 'Fast Warble (emergency)' },
  { id: 'buzz-alarm', displayName: 'Alarm Buzz' },
  { id: 'klaxon-honk', displayName: 'Klaxon Honk' },
  { id: 'knock-soft', displayName: 'Soft Knock' },
  { id: 'gong', displayName: 'Gong' },
];

/** Format gate for a named-tone id — a lowercase slug, never a 16-hex custom id. */
export const BUILTIN_TONE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

const BUILTIN_TONE_IDS: ReadonlySet<string> = new Set(BUILTIN_TONES.map((t) => t.id));

// Fail loudly at module load if the catalog and the synth builders drift apart
// (a future edit adding a BUILTIN_TONES entry without its NAMED_TONE_BUILDERS
// fn). Better a refused deploy than a catalog tone that writes no WAV, is
// accepted by updateChimeConfig, and silently resolves to the klaxon at render.
for (const t of BUILTIN_TONES) {
  if (!NAMED_TONE_BUILDERS[t.id]) {
    throw new Error(`audioAssets: built-in tone '${t.id}' is in the catalog but has no synth builder`);
  }
}

/** True iff `id` names a tone in the built-in catalog. */
export function isBuiltinTone(id: string): boolean {
  return BUILTIN_TONE_IDS.has(id);
}

/**
 * Resolve a named built-in tone to its on-disk WAV path, or null when the id
 * isn't in the catalog, escapes `audioDir`, or the file isn't present. Mirrors
 * chimeStore.chimeFilePath's containment guarantee; callers fall back to the
 * level klaxon on null so a missing tone never silences an alarm.
 */
export function builtinTonePath(id: string, audioDir: string): string | null {
  if (!isBuiltinTone(id)) return null;
  const p = resolve(audioDir, `${id}.wav`);
  const base = audioDir.endsWith(sep) ? audioDir : audioDir + sep;
  if (!p.startsWith(base) || !existsSync(p)) return null;
  return p;
}

/* ─── public API ──────────────────────────────────────────────────── */

export const AUDIO_ASSETS = ['red-alert', 'yellow-alert', 'all-clear', 'boatswain'] as const;
export type AudioAssetId = (typeof AUDIO_ASSETS)[number];

/** Chime sound packs. "powerplant" (default) = ISA-18.2 industrial annunciator
 *  cadences; "airport" = the v0.9.70 melodic struck-bell PA chimes. */
export type ChimePack = 'powerplant' | 'airport';

/** Resolve the active pack from the BROADCAST_CHIME_PACK option (default powerplant). */
export function selectedChimePack(): ChimePack {
  return process.env.BROADCAST_CHIME_PACK === 'airport' ? 'airport' : 'powerplant';
}

/** Per-pack synthesis. Same asset ids/filenames; only the waveform differs, so
 *  the broadcast/render pipeline is unchanged — switching packs just re-synthesizes. */
const CHIME_PACKS: Record<ChimePack, Record<AudioAssetId, () => { segs: Segment[]; totalSec: number }>> = {
  airport: {
    'red-alert': redAlertSegments,
    'yellow-alert': yellowAlertSegments,
    'all-clear': allClearSegments,
    'boatswain': boatswainSegments,
  },
  powerplant: {
    'red-alert': ppRedAlertSegments,
    'yellow-alert': ppYellowAlertSegments,
    'all-clear': ppAllClearSegments,
    'boatswain': boatswainSegments,
  },
};

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
 *
 * v0.17.0 — bumped 3 → 4 when the named built-in tone library (BUILTIN_TONES)
 * was added: the bump forces an existing /data/audio to regenerate so the new
 * <id>.wav tones appear without manual cleanup. The 4 legacy klaxon ids and
 * their waveforms are unchanged (only re-written, byte-identically).
 * v0.23.0 — bumped 4 → 5: addTone now floors the onset attack (~4 ms) to kill a
 * sample-0 click on zero-attack tones that read as a clipped tone start; the
 * bump regenerates /data/audio so the softened tones replace the clicky ones.
 */
export const AUDIO_ASSETS_VERSION = 5;

/** v0.23.0 — write a WAV atomically (tmp → rename) so a deploy/boot interrupted
 *  mid-write can never leave a torn/short <id>.wav that the renderer would embed
 *  into a (cached) combined announcement as a clipped tone. */
async function writeWavAtomic(path: string, data: Buffer): Promise<void> {
  const { rename } = await import('node:fs/promises');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Write all assets to `outDir`. Regenerates if the on-disk version is stale. */
export async function generateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }
  // v0.9.70 — version-gated regeneration. v0.13.0 — the marker now also carries
  // the active chime PACK (e.g. "3:powerplant"), so switching BROADCAST_CHIME_PACK
  // regenerates the WAVs on next boot just like a synthesis-param bump.
  const pack = selectedChimePack();
  const wantMarker = `${AUDIO_ASSETS_VERSION}:${pack}`;
  const versionMarker = resolve(outDir, '.assets-version');
  // TOCTOU hardening (CodeQL js/file-system-race): read the marker directly —
  // absent and unreadable both land in the catch and read as '' (stale),
  // exactly like the old existsSync-guarded read.
  let onDiskMarker = '';
  try {
    onDiskMarker = (await readFile(versionMarker, 'utf8')).trim();
  } catch { /* absent/unreadable — treat as empty (stale) */ }
  const stale = onDiskMarker !== wantMarker;
  if (stale && onDiskMarker) {
    log(`audioAssets: marker "${onDiskMarker}" on disk, regenerating for "${wantMarker}"`);
  }
  const defs = CHIME_PACKS[pack];
  for (const id of AUDIO_ASSETS) {
    const path = resolve(outDir, `${id}.wav`);
    if (!stale && existsSync(path)) continue;
    const { segs, totalSec } = defs[id]();
    const samples = renderSegments(segs, totalSec);
    const wav = buildWavBuffer(samples);
    await mkdir(dirname(path), { recursive: true });
    await writeWavAtomic(path, wav);
    log(`audioAssets: wrote ${id}.wav [${pack}] (${(wav.length / 1024).toFixed(1)} KB, ${totalSec.toFixed(2)} s)`);
  }
  // v0.17.0 — the named built-in tone library, written alongside the klaxons
  // (pack-independent: same bytes regardless of BROADCAST_CHIME_PACK).
  for (const tone of BUILTIN_TONES) {
    const path = resolve(outDir, `${tone.id}.wav`);
    if (!stale && existsSync(path)) continue;
    const builder = NAMED_TONE_BUILDERS[tone.id];
    if (!builder) { log(`audioAssets: WARN no synth builder for built-in tone ${tone.id}`); continue; }
    const { segs, totalSec } = builder();
    const samples = renderSegments(segs, totalSec);
    const wav = buildWavBuffer(samples);
    await writeWavAtomic(path, wav);
    log(`audioAssets: wrote ${tone.id}.wav (${(wav.length / 1024).toFixed(1)} KB, ${totalSec.toFixed(2)} s)`);
  }
  // Write the marker only when it was stale/missing at boot. `wantMarker` is
  // never empty, so a missing/unreadable marker always read as stale above —
  // no existsSync re-check needed (that exists→write pair was the CodeQL
  // js/file-system-race TOCTOU; a concurrent delete now just means one extra
  // regeneration next boot, same as any other lost-marker case).
  if (stale) {
    await writeFile(versionMarker, wantMarker + '\n');
  }
}

/** Force-regenerate (used by tests / explicit "reset audio" trigger). */
export async function regenerateAudioAssets(outDir: string, log: (m: string) => void): Promise<void> {
  // `rm(force)` removes-if-present in one call — no exists→unlink TOCTOU pair.
  const { rm } = await import('node:fs/promises');
  for (const id of AUDIO_ASSETS) {
    await rm(resolve(outDir, `${id}.wav`), { force: true });
  }
  for (const tone of BUILTIN_TONES) {
    await rm(resolve(outDir, `${tone.id}.wav`), { force: true });
  }
  await rm(resolve(outDir, '.assets-version'), { force: true });
  return generateAudioAssets(outDir, log);
}
