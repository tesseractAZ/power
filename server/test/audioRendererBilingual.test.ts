import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderAnnouncement, _resetResidentVoiceForTest } from '../src/audioRenderer.js';
import { pcmToWav } from '../src/wyomingTts.js';
import { generateAudioAssets } from '../src/audioAssets.js';

/* v1.47.4 — bilingual render reliability. Piper keeps one voice resident and
 * cold-loads on each switch; a heavy/contended Spanish pass could time out and
 * drop, leaving an English-only alarm. Two guarantees are proven with an
 * injected fake Wyoming renderer: (1) a transient pass failure is RETRIED and
 * recovers (both languages survive); (2) the render order is RESIDENT-VOICE
 * FIRST across broadcasts, so a bilingual alarm reloads models at most twice
 * (not four times). */

// A 22050/16/mono WAV that matches the klaxon format (so no format-mismatch drop).
function fakeWav(ms: number): Buffer {
  const samples = Math.max(1, Math.round((22050 * ms) / 1000));
  return pcmToWav(Buffer.alloc(samples * 2), 22050, 2, 1);
}

async function withDirs(fn: (klaxonDir: string, cacheDir: string) => Promise<void>) {
  const klaxonDir = mkdtempSync(resolve(tmpdir(), 'ef-klaxon-'));
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-cache-'));
  try { await generateAudioAssets(klaxonDir, () => {}); await fn(klaxonDir, cacheDir); }
  finally { rmSync(klaxonDir, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); }
}

const baseOpts = (klaxonDir: string, cacheDir: string) => ({
  level: 'red' as const,
  message: 'Critical alarm.',
  messages: [
    { text: 'Critical alarm.', voice: 'en_US-lessac-medium', lang: 'en' as const },
    { text: 'Alarma critica.', voice: 'es_MX-ald-medium', lang: 'es' as const },
  ],
  klaxonDir, cacheDir, wyomingHost: 'x', wyomingPort: 1,
  endOfMessage: false, // isolate the pass render order from terminators
  log: () => {},
});

test('v1.47.4 — a transient Spanish pass failure is retried and recovers (both pass)', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    const calls: Array<{ voice?: string; ok: boolean }> = [];
    let esAttempts = 0;
    const renderTts = async (o: { voice?: string }) => {
      if (o.voice === 'es_MX-ald-medium') {
        esAttempts++;
        if (esAttempts === 1) { calls.push({ voice: o.voice, ok: false }); return { ok: false as const, error: 'wyoming socket: ' }; }
      }
      calls.push({ voice: o.voice, ok: true });
      return { ok: true as const, wav: fakeWav(300), durationMs: 5 };
    };
    const r = await renderAnnouncement({ ...baseOpts(klaxonDir, cacheDir), renderTts } as any);
    assert.equal(r.ok, true, 'render succeeds');
    assert.equal(r.fromCache, false);
    // Spanish was attempted twice (fail then retry-success); both languages rendered.
    assert.equal(esAttempts, 2, 'Spanish pass retried once');
    const okVoices = calls.filter((c) => c.ok).map((c) => c.voice);
    assert.ok(okVoices.includes('en_US-lessac-medium') && okVoices.includes('es_MX-ald-medium'), 'both languages present');
    // A complete render is NOT a partial file.
    assert.ok(!r.filename?.includes('.partial.'), 'complete render, not partial');
  });
});

test('v1.47.4 — render order is resident-voice-first across broadcasts', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    const order: string[] = [];
    const renderTts = async (o: { voice?: string }) => { order.push(o.voice ?? ''); return { ok: true as const, wav: fakeWav(200), durationMs: 5 }; };
    // First broadcast (no resident): default order en, es. Ends resident=es.
    await renderAnnouncement({ ...baseOpts(klaxonDir, cacheDir), message: 'A', messages: [
      { text: 'A', voice: 'en_US-lessac-medium', lang: 'en' as const },
      { text: 'Aes', voice: 'es_MX-ald-medium', lang: 'es' as const },
    ], renderTts } as any);
    assert.deepEqual(order, ['en_US-lessac-medium', 'es_MX-ald-medium'], 'first broadcast: en then es');
    // Second broadcast (resident=es from last render): es rendered FIRST (no reload), then en.
    order.length = 0;
    await renderAnnouncement({ ...baseOpts(klaxonDir, cacheDir), message: 'B', messages: [
      { text: 'B', voice: 'en_US-lessac-medium', lang: 'en' as const },
      { text: 'Bes', voice: 'es_MX-ald-medium', lang: 'es' as const },
    ], renderTts } as any);
    assert.deepEqual(order, ['es_MX-ald-medium', 'en_US-lessac-medium'], 'second broadcast: resident es first');
  });
});


/* v1.47.5 — bounded alarm latency + no-retry-on-timeout. Live incident: a
 * CPU-starved host made Piper 6-10x slower, every pass timed out, the blanket
 * v1.47.4 retry doubled each wait, and the alarm took 151 s to sound. The
 * chime must not wait on a sick TTS server. */

test('v1.47.5 — a timeout is NOT retried (one attempt per pass when the server is wedged)', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    let attempts = 0;
    // Simulate a wedged server: every call consumes its full timeout, then fails.
    const renderTts = async (o: { timeoutMs?: number }) => {
      attempts++;
      await new Promise((r) => setTimeout(r, Math.min(120, o.timeoutMs ?? 50)));
      return { ok: false as const, error: `wyoming render timeout after ${o.timeoutMs}ms` };
    };
    const r = await renderAnnouncement({
      ...baseOpts(klaxonDir, cacheDir), renderTts,
      // Tiny budget so the test is fast; per-attempt timeout is clamped to it.
    } as any);
    assert.equal(r.ok, false, 'all passes failed → hard error (caller falls back to chime-only)');
    // TWO passes, ONE attempt each — no retry after a timeout.
    assert.equal(attempts, 2, `expected 1 attempt per pass, got ${attempts}`);
  });
});

test('v1.47.5 — the spoken phase is budget-bounded (alarm does not wait indefinitely)', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    process.env.BROADCAST_TTS_TOTAL_BUDGET_MS = '5000'; // floor of the accepted range
    try {
      let attempts = 0;
      const renderTts = async (o: { timeoutMs?: number }) => {
        attempts++;
        await new Promise((r) => setTimeout(r, Math.max(1, Math.min(o.timeoutMs ?? 50, 1200))));
        return { ok: false as const, error: 'wyoming render timeout' };
      };
      const t0 = Date.now();
      const r = await renderAnnouncement({ ...baseOpts(klaxonDir, cacheDir), endOfMessage: true, renderTts } as any);
      const elapsed = Date.now() - t0;
      assert.equal(r.ok, false);
      // Passes + terminators all fail, but the whole phase stays bounded — it must
      // never approach the unbounded per-item sum that produced the 151 s alarm.
      assert.ok(elapsed < 20000, `spoken phase took ${elapsed}ms — expected bounded`);
      assert.ok(attempts <= 4, `expected attempts bounded by budget, got ${attempts}`);
    } finally {
      delete process.env.BROADCAST_TTS_TOTAL_BUDGET_MS;
    }
  });
});
