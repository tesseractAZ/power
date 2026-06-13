import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// CHIMES_DIR is read at module-load time → set env BEFORE the import.
const tmp = mkdtempSync(resolve(tmpdir(), 'chimestore-test-'));
process.env.CHIMES_DIR = tmp;

const {
  normalizeToTarget, saveChime, listChimes, deleteChime, chimePath, chimeExists,
  TARGET_RATE, MAX_CHIME_COUNT, MAX_UPLOAD_BYTES, MAX_DURATION_MS,
} = await import('../src/chimeStore.js');
const { parseWavHeader } = await import('../src/audioRenderer.js');

/** Build a minimal WAV in an arbitrary format, filled by `fill(frame, channel) → [-1,1]`. */
function buildWav(o: {
  rate: number; channels: number; bits: number; formatTag?: number; frames: number;
  fill?: (f: number, c: number) => number;
}): Buffer {
  const formatTag = o.formatTag ?? 1;
  const bps = o.bits / 8;
  const dataLen = o.frames * o.channels * bps;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(formatTag, 20);
  buf.writeUInt16LE(o.channels, 22); buf.writeUInt32LE(o.rate, 24);
  buf.writeUInt32LE(o.rate * o.channels * bps, 28);
  buf.writeUInt16LE(o.channels * bps, 32); buf.writeUInt16LE(o.bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  let p = 44;
  for (let f = 0; f < o.frames; f++) {
    for (let c = 0; c < o.channels; c++) {
      const v = o.fill ? o.fill(f, c) : 0;
      if (formatTag === 3 && o.bits === 32) { buf.writeFloatLE(v, p); p += 4; }
      else if (o.bits === 16) { buf.writeInt16LE(Math.round(v * 32767), p); p += 2; }
      else if (o.bits === 8) { buf.writeUInt8(Math.round(v * 127) + 128, p); p += 1; }
      else if (o.bits === 24) {
        const iv = Math.round(v * 8388607) & 0xffffff;
        buf.writeUInt8(iv & 0xff, p); buf.writeUInt8((iv >> 8) & 0xff, p + 1); buf.writeUInt8((iv >> 16) & 0xff, p + 2); p += 3;
      } else if (o.bits === 32) { buf.writeInt32LE(Math.round(v * 2147483647), p); p += 4; }
    }
  }
  return buf;
}

const sine = (freq: number, rate: number) => (f: number) => Math.sin((2 * Math.PI * freq * f) / rate) * 0.8;

/* ─── normalizeToTarget — the safety-critical conversion ──────────────── */

test('normalize — 44100 Hz stereo 16-bit → 22050/16/mono', () => {
  const wav = buildWav({ rate: 44100, channels: 2, bits: 16, frames: 44100, fill: sine(440, 44100) });
  const r = normalizeToTarget(wav);
  assert.ok(r.ok, r.error);
  const h = parseWavHeader(r.wav!);
  assert.equal(h.rate, TARGET_RATE);
  assert.equal(h.channels, 1);
  assert.equal(h.width, 2);
  // 1 s of source → ~1 s of output (±1 frame).
  assert.ok(Math.abs((r.durationMs ?? 0) - 1000) <= 5, `duration ${r.durationMs}`);
  assert.equal(r.srcRate, 44100);
  assert.equal(r.srcChannels, 2);
});

test('normalize — 22050 mono 16-bit passes through to the same format/length', () => {
  const wav = buildWav({ rate: 22050, channels: 1, bits: 16, frames: 11025, fill: sine(440, 22050) });
  const r = normalizeToTarget(wav);
  assert.ok(r.ok, r.error);
  const h = parseWavHeader(r.wav!);
  assert.equal(h.rate, 22050); assert.equal(h.channels, 1); assert.equal(h.width, 2);
  assert.ok(Math.abs((r.durationMs ?? 0) - 500) <= 5);
});

test('normalize — accepts 8-bit, 24-bit, and 32-bit float encodings', () => {
  for (const [bits, formatTag] of [[8, 1], [24, 1], [32, 3]] as const) {
    const wav = buildWav({ rate: 48000, channels: 1, bits, formatTag, frames: 24000, fill: sine(330, 48000) });
    const r = normalizeToTarget(wav);
    assert.ok(r.ok, `bits=${bits} fmt=${formatTag}: ${r.error}`);
    const h = parseWavHeader(r.wav!);
    assert.equal(h.rate, TARGET_RATE); assert.equal(h.channels, 1); assert.equal(h.width, 2);
  }
});

test('normalize — rejects non-WAV, too-small, and over-long inputs', () => {
  assert.equal(normalizeToTarget(Buffer.from('not a wav at all!!')).ok, false);
  assert.equal(normalizeToTarget(Buffer.alloc(10)).ok, false);
  const tooLong = buildWav({ rate: 22050, channels: 1, bits: 16, frames: TARGET_RATE * (MAX_DURATION_MS / 1000 + 2) });
  const r = normalizeToTarget(tooLong);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /too long/);
});

/* ─── store / list / delete / content-addressing ─────────────────────── */

const tone = (freq: number, frames = 4410) =>
  buildWav({ rate: 22050, channels: 1, bits: 16, frames, fill: sine(freq, 22050) });

test('saveChime — stores, lists, and content-addresses (re-upload de-dupes)', () => {
  const a = saveChime(tone(440), 'my alarm.wav');
  assert.ok(a.ok, a.error);
  assert.match(a.meta!.id, /^[a-f0-9]{16}$/);
  assert.equal(a.meta!.originalName, 'my alarm.wav');
  assert.ok(chimeExists(a.meta!.id));
  assert.ok(chimePath(a.meta!.id)?.endsWith(`${a.meta!.id}.wav`));
  // Same audio, different name → same id (content-addressed).
  const a2 = saveChime(tone(440), 'renamed.wav');
  assert.equal(a2.meta!.id, a.meta!.id);
  // A different tone → different id.
  const b = saveChime(tone(880), 'other.wav');
  assert.notEqual(b.meta!.id, a.meta!.id);
  const ids = listChimes().map((c) => c.id);
  assert.ok(ids.includes(a.meta!.id) && ids.includes(b.meta!.id));
});

test('saveChime — rejects oversize uploads and a full library', () => {
  assert.equal(saveChime(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'huge.wav').ok, false);
  assert.equal(saveChime(Buffer.alloc(0), 'empty.wav').ok, false);
  // Fill the library to the cap with distinct tones, then assert the next fails.
  for (let i = 0; i < MAX_CHIME_COUNT + 2; i++) saveChime(tone(200 + i * 23, 4410 + i * 7), `t${i}.wav`);
  assert.ok(listChimes().length <= MAX_CHIME_COUNT, `count ${listChimes().length} exceeds cap`);
  const overflow = saveChime(tone(50, 9999), 'one-too-many.wav');
  assert.equal(overflow.ok, false);
  assert.match(overflow.error ?? '', /full/);
});

test('deleteChime — removes file + manifest entry; path-traversal ids are rejected', () => {
  // The prior test fills the library to the cap → free a slot first so the save below succeeds.
  for (const ch of listChimes()) deleteChime(ch.id);
  const c = saveChime(tone(1234, 3000), 'del.wav');
  assert.ok(c.ok, c.error);
  const id = c.meta!.id;
  assert.ok(chimeExists(id));
  assert.equal(deleteChime(id), true);
  assert.equal(chimeExists(id), false);
  assert.equal(listChimes().some((x) => x.id === id), false);
  // Malformed / traversal ids never resolve to a path and never delete.
  assert.equal(chimePath('../../etc/passwd'), null);
  assert.equal(deleteChime('../../etc/passwd'), false);
  assert.equal(deleteChime('not-hex'), false);
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// silence unused-import lint for the existsSync import kept for clarity
void existsSync;
