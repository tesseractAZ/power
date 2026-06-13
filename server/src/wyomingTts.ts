/**
 * v0.9.70 — Wyoming Protocol TTS client.
 *
 * Renders TTS audio by speaking the Wyoming Protocol directly to the
 * Piper add-on over TCP. Bypasses HA Core entirely — no `/api/tts_get_url`
 * call, no Supervisor proxy in the path, no `tts.speak` service-call
 * ceremony. Just a clean producer-consumer:
 *
 *     panel → TCP core-piper:10200 → Wyoming events → PCM chunks → WAV
 *
 * This was added because v0.9.18 → v0.9.69 went through six iterations
 * trying to route TTS through HA Core's various TTS surfaces:
 *   - v0.9.30: tts.speak with media_player target
 *   - v0.9.31: per-engine fallback chain
 *   - v0.9.39: media_stop before tts.speak (didn't help — MA re-acquires)
 *   - v0.9.41: tts_get_url + MA.play_announcement (the URL-rendering path)
 *   - v0.9.63: en-US ↔ en_US retry chain (Wyoming POSIX vs Cloud BCP47)
 *   - v0.9.65: REQUIRE_LOCAL + pin-disables-fallback
 *
 * Every fix exposed a new failure mode. When HA 2026.6.0b0's supervisor
 * proxy started returning 500 on tts_get_url (working as recently as
 * v0.9.65), it became clear the right move was to remove HA from the TTS
 * critical path entirely and talk to Piper directly.
 *
 * The Wyoming protocol (https://github.com/rhasspy/wyoming) is JSON
 * events over TCP, optionally with binary payloads. For TTS we need
 * three event types:
 *
 *   - `synthesize` (we send): `{"text": "...", "voice": {"name": "..."}}`
 *   - `audio-start` (we receive): the audio format (rate, width, channels)
 *   - `audio-chunk` (we receive, repeated): binary PCM payload
 *   - `audio-stop` (we receive): done — assemble PCM and return
 *
 * Event framing:
 *   - One header line per event (JSON terminated by '\n')
 *   - Header may declare `data_length` + `payload_length`
 *   - data_length bytes of additional JSON follow the header line
 *   - payload_length bytes of binary payload follow the JSON data
 *
 * We don't query the `describe` event because the Piper add-on always
 * exposes one voice per startup (configured via add-on options), so the
 * synthesize event without a voice spec defaults to the configured voice.
 * If the caller wants a specific voice, pass it in opts.voice.
 */

import { connect } from 'node:net';
import { Buffer } from 'node:buffer';

export interface WyomingTtsOptions {
  /** TCP host. From inside the panel addon container: `core-piper`. */
  host: string;
  /** TCP port. Piper default: 10200. */
  port: number;
  /** Text to synthesize. */
  text: string;
  /** Optional voice override (e.g. "en_US-amy-medium"). Defaults to add-on configured voice. */
  voice?: string;
  /** Hard timeout for the entire render. Default 15 s. */
  timeoutMs?: number;
}

export interface WyomingTtsResult {
  ok: boolean;
  /** Full WAV bytes (44-byte header + PCM data) when ok=true. */
  wav?: Buffer;
  error?: string;
  /** Audio format metadata reported by audio-start. */
  rate?: number;
  width?: number;
  channels?: number;
  /** Wall-clock render time (ms) — useful for debugging slow renders. */
  durationMs?: number;
}

/**
 * Connect to a Wyoming server, send a synthesize event, and assemble
 * the streaming audio response into a complete WAV buffer.
 *
 * Resilient to:
 *   - TCP-level errors (connect refused, RST mid-stream)
 *   - Malformed events (JSON parse failure)
 *   - Hung server (timeout)
 *   - Empty payloads (no audio-chunk between start and stop)
 *
 * Does NOT retry — the caller decides retry policy (e.g. renderer cache
 * may want to retry once on transient TCP error before giving up).
 */
export async function renderWyomingTts(opts: WyomingTtsOptions): Promise<WyomingTtsResult> {
  const { host, port, text, voice, timeoutMs = 15000 } = opts;
  const t0 = Date.now();

  return new Promise<WyomingTtsResult>((resolve) => {
    const socket = connect({ host, port });
    let buf = Buffer.alloc(0);
    let resolved = false;
    const chunks: Buffer[] = [];
    let rate = 22050;
    let width = 2;
    let channels = 1;
    let sawAudioStart = false;

    const finish = (r: WyomingTtsResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      resolve({ ...r, durationMs: Date.now() - t0 });
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `wyoming render timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );

    socket.on('error', (e) => finish({ ok: false, error: `wyoming socket: ${e.message}` }));

    socket.on('connect', () => {
      // Send synthesize event. Voice override is optional; omit the
      // `voice` key entirely when not specified so Piper falls back to
      // its configured default (the add-on's `voice` option).
      const data: { text: string; voice?: { name: string } } = { text };
      if (voice) data.voice = { name: voice };
      const event = { type: 'synthesize', data };
      const headerLine = JSON.stringify(event) + '\n';
      socket.write(headerLine);
    });

    socket.on('end', () => {
      // Connection closed by server — if we already saw audio-stop we'd
      // have resolved. Otherwise this is premature.
      finish({ ok: false, error: sawAudioStart ? 'wyoming closed before audio-stop' : 'wyoming closed before any audio' });
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Parse zero or more complete events from the buffer.
      while (true) {
        const nl = buf.indexOf(0x0A); // '\n'
        if (nl < 0) break; // need more bytes for the header line
        let header: { type?: string; data?: any; data_length?: number; payload_length?: number };
        try {
          header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        } catch (e: any) {
          return finish({ ok: false, error: `wyoming bad header: ${e?.message ?? e}` });
        }
        const dataLen = header.data_length ?? 0;
        const payloadLen = header.payload_length ?? 0;
        const totalLen = nl + 1 + dataLen + payloadLen;
        if (buf.length < totalLen) break; // need more bytes

        // Extended data (if data_length set) overrides the inline header.data
        let eventData: any = header.data ?? null;
        if (dataLen > 0) {
          try {
            eventData = JSON.parse(buf.subarray(nl + 1, nl + 1 + dataLen).toString('utf8'));
          } catch (e: any) {
            return finish({ ok: false, error: `wyoming bad data: ${e?.message ?? e}` });
          }
        }
        const payload = payloadLen > 0 ? buf.subarray(nl + 1 + dataLen, totalLen) : null;
        buf = buf.subarray(totalLen);

        // Dispatch
        if (header.type === 'audio-start') {
          sawAudioStart = true;
          if (eventData) {
            if (typeof eventData.rate === 'number') rate = eventData.rate;
            if (typeof eventData.width === 'number') width = eventData.width;
            if (typeof eventData.channels === 'number') channels = eventData.channels;
          }
        } else if (header.type === 'audio-chunk') {
          if (payload && payload.length > 0) chunks.push(payload);
        } else if (header.type === 'audio-stop') {
          const pcm = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
          if (pcm.length === 0) {
            return finish({ ok: false, error: 'wyoming returned audio-stop with no audio-chunks' });
          }
          const wav = pcmToWav(pcm, rate, width, channels);
          return finish({ ok: true, wav, rate, width, channels });
        } else if (header.type === 'error') {
          // Wyoming spec includes an error event for synthesize failures
          // (e.g. unknown voice name). Surface the server-side text.
          const msg = (eventData && (eventData.text || eventData.message)) || 'wyoming server error';
          return finish({ ok: false, error: `wyoming: ${msg}` });
        }
        // Other event types (e.g. 'info', 'describe') are ignored — they
        // arrive when the server is chatty but don't affect synthesis.
      }
    });
  });
}

/**
 * Wrap a raw PCM buffer in a 44-byte RIFF/WAVE header.
 *
 * Format: PCM, little-endian, fixed channels/rate/width per inputs.
 * Identical layout to audioAssets.ts's `buildWavBuffer` so the two
 * renderers produce compatible WAVs (a requirement for the v0.9.70
 * klaxon+TTS concatenation in audioRenderer.ts — both halves MUST have
 * the same sample format or concat is a no-go).
 */
export function pcmToWav(pcm: Buffer, rate: number, width: number, channels: number): Buffer {
  // v0.20.0 — one allocation: write the 44-byte header directly into the output
  // buffer and copy the PCM after it, instead of allocating a header + concat
  // (which copies the full payload a second time). allocUnsafe is safe here —
  // all 44 header bytes are written explicitly below and bytes 44.. are filled
  // by pcm.copy, so nothing uninitialized is ever returned. Byte-identical to
  // the prior Buffer.concat([header, pcm]) (all field writes are explicit LE).
  const out = Buffer.allocUnsafe(44 + pcm.length);
  let o = 0;
  out.write('RIFF', o); o += 4;
  out.writeUInt32LE(36 + pcm.length, o); o += 4;
  out.write('WAVE', o); o += 4;
  out.write('fmt ', o); o += 4;
  out.writeUInt32LE(16, o); o += 4;                              // subchunk1 size
  out.writeUInt16LE(1, o); o += 2;                               // PCM format
  out.writeUInt16LE(channels, o); o += 2;
  out.writeUInt32LE(rate, o); o += 4;
  out.writeUInt32LE(rate * channels * width, o); o += 4;         // byte rate
  out.writeUInt16LE(channels * width, o); o += 2;                // block align
  out.writeUInt16LE(width * 8, o); o += 2;                       // bits per sample
  out.write('data', o); o += 4;
  out.writeUInt32LE(pcm.length, o);
  pcm.copy(out, 44);
  return out;
}
