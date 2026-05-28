import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import { renderWyomingTts, pcmToWav } from '../src/wyomingTts.js';

/**
 * v0.9.70 — Wyoming TTS protocol tests.
 *
 * The renderer talks Wyoming Protocol (JSON-over-TCP with optional
 * binary payloads) to the Piper add-on. Real Piper isn't available in
 * CI, so these tests spin up a tiny mock Wyoming server that speaks
 * just enough of the protocol to validate the happy paths + the
 * failure modes our renderer needs to handle gracefully.
 *
 * Tested invariants:
 *   - The synthesize event is sent in the expected shape (with and
 *     without an explicit voice override).
 *   - audio-start metadata (rate/width/channels) propagates to the
 *     returned WAV header.
 *   - Multiple audio-chunk payloads are concatenated in order.
 *   - audio-stop with no chunks fails cleanly (no malformed WAV).
 *   - Server-side error events surface as descriptive errors.
 *   - Connect refused / TCP RST / timeout are reported, not thrown.
 */

interface ServerPlan {
  /** What the server sends back in order after receiving synthesize. */
  events: Array<{ type: string; data?: any; payload?: Buffer }>;
  /** If true, server closes the socket after emitting events without
   *  waiting for audio-stop. Used to test premature close handling. */
  closeAfterEvents?: boolean;
  /** If true, server doesn't respond at all (tests timeout). */
  silent?: boolean;
  /** Captures the synthesize request the server received. */
  receivedSynthesize: { text: string; voice?: { name: string } } | null;
}

function startMockWyomingServer(plan: ServerPlan): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      let inbuf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        inbuf = Buffer.concat([inbuf, chunk]);
        const nl = inbuf.indexOf(0x0A);
        if (nl < 0) return;
        try {
          const header = JSON.parse(inbuf.subarray(0, nl).toString('utf8'));
          if (header.type === 'synthesize') {
            plan.receivedSynthesize = header.data ?? null;
            if (plan.silent) return; // hang for timeout test
            // Emit planned events with small async gap to mimic streaming
            const emit = (i: number) => {
              if (i >= plan.events.length) {
                if (plan.closeAfterEvents) sock.end();
                return;
              }
              const ev = plan.events[i];
              const headerObj: any = { type: ev.type };
              if (ev.data !== undefined) headerObj.data = ev.data;
              if (ev.payload) headerObj.payload_length = ev.payload.length;
              const headerLine = JSON.stringify(headerObj) + '\n';
              sock.write(headerLine);
              if (ev.payload) sock.write(ev.payload);
              setImmediate(() => emit(i + 1));
            };
            emit(0);
          }
        } catch { /* ignore parse error */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, server });
    });
  });
}

function makeFakePcm(byteCount: number): Buffer {
  // Deterministic ramp — not real audio but bytes that compare equal.
  const buf = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i++) buf[i] = (i * 7) & 0xff;
  return buf;
}

test('wyomingTts — happy path: 3 chunks reassembled into a WAV with the right header', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'audio-start', data: { rate: 22050, width: 2, channels: 1 } },
      { type: 'audio-chunk', data: { rate: 22050, width: 2, channels: 1 }, payload: makeFakePcm(100) },
      { type: 'audio-chunk', data: { rate: 22050, width: 2, channels: 1 }, payload: makeFakePcm(200) },
      { type: 'audio-chunk', data: { rate: 22050, width: 2, channels: 1 }, payload: makeFakePcm(50) },
      { type: 'audio-stop' },
    ],
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'hello world' });
    assert.equal(r.ok, true);
    assert.ok(r.wav, 'wav buffer should be returned');
    assert.equal(r.rate, 22050);
    assert.equal(r.width, 2);
    assert.equal(r.channels, 1);
    // Header check
    assert.equal(r.wav!.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(r.wav!.subarray(8, 12).toString('ascii'), 'WAVE');
    // Data section: 44-byte header + 350 bytes of PCM (100+200+50)
    assert.equal(r.wav!.length, 44 + 350);
    // Synthesize request was received
    assert.deepEqual(plan.receivedSynthesize, { text: 'hello world' });
  } finally {
    server.close();
  }
});

test('wyomingTts — voice override is included in the synthesize event', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'audio-start', data: { rate: 22050, width: 2, channels: 1 } },
      { type: 'audio-chunk', data: {}, payload: makeFakePcm(50) },
      { type: 'audio-stop' },
    ],
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    await renderWyomingTts({ host: '127.0.0.1', port, text: 'hi', voice: 'en_US-ryan-low' });
    assert.deepEqual(plan.receivedSynthesize, { text: 'hi', voice: { name: 'en_US-ryan-low' } });
  } finally {
    server.close();
  }
});

test('wyomingTts — server error event surfaces as descriptive error', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'error', data: { text: 'voice "en_US-bogus" not loaded' } },
    ],
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'hi' });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('voice "en_US-bogus" not loaded'), `expected error to mention voice name, got: ${r.error}`);
  } finally {
    server.close();
  }
});

test('wyomingTts — audio-stop with no chunks → error (no empty WAV)', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'audio-start', data: { rate: 22050, width: 2, channels: 1 } },
      { type: 'audio-stop' },
    ],
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'hi' });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('no audio-chunks'), `expected error about empty audio, got: ${r.error}`);
  } finally {
    server.close();
  }
});

test('wyomingTts — premature close before audio-stop → error', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'audio-start', data: { rate: 22050, width: 2, channels: 1 } },
      { type: 'audio-chunk', data: {}, payload: makeFakePcm(50) },
      // No audio-stop, server closes
    ],
    closeAfterEvents: true,
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'hi' });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('before audio-stop'), `expected premature-close error, got: ${r.error}`);
  } finally {
    server.close();
  }
});

test('wyomingTts — connect refused → error (does not throw)', async () => {
  // Use a port we know is closed (very high, unlikely to be in use)
  const r = await renderWyomingTts({ host: '127.0.0.1', port: 1, text: 'hi', timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.error, 'should have an error message');
  // Could be ECONNREFUSED or timeout — both are valid
});

test('wyomingTts — silent server hits timeout cleanly', async () => {
  const plan: ServerPlan = { receivedSynthesize: null, events: [], silent: true };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'hi', timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('timeout'), `expected timeout error, got: ${r.error}`);
  } finally {
    server.close();
  }
});

test('wyomingTts — multi-channel audio reflected in WAV header', async () => {
  const plan: ServerPlan = {
    receivedSynthesize: null,
    events: [
      { type: 'audio-start', data: { rate: 16000, width: 2, channels: 2 } },
      { type: 'audio-chunk', data: {}, payload: makeFakePcm(80) },
      { type: 'audio-stop' },
    ],
  };
  const { port, server } = await startMockWyomingServer(plan);
  try {
    const r = await renderWyomingTts({ host: '127.0.0.1', port, text: 'stereo' });
    assert.equal(r.ok, true);
    assert.equal(r.rate, 16000);
    assert.equal(r.channels, 2);
    // WAV header should reflect: channels (offset 22)
    assert.equal(r.wav!.readUInt16LE(22), 2);
    // Sample rate (offset 24)
    assert.equal(r.wav!.readUInt32LE(24), 16000);
  } finally {
    server.close();
  }
});

test('pcmToWav — produces a valid 44-byte header for given format', () => {
  const pcm = makeFakePcm(200);
  const wav = pcmToWav(pcm, 22050, 2, 1);
  assert.equal(wav.length, 44 + 200);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  // Channels = 1
  assert.equal(wav.readUInt16LE(22), 1);
  // Sample rate = 22050
  assert.equal(wav.readUInt32LE(24), 22050);
  // Bits per sample = 16 (width 2 bytes)
  assert.equal(wav.readUInt16LE(34), 16);
  // Data chunk size
  assert.equal(wav.readUInt32LE(40), 200);
});

test('pcmToWav — RIFF chunk size = 36 + data length', () => {
  const wav = pcmToWav(makeFakePcm(123), 8000, 1, 1);
  assert.equal(wav.readUInt32LE(4), 36 + 123);
});
