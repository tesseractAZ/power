import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderAnnouncement, prewarmTerminatorCache, pruneRenderCache, _resetResidentVoiceForTest, _resetTerminatorCacheForTest } from '../src/audioRenderer.js';
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


/* v1.47.6 — the terminator phrases never change, so they must be rendered at
 * most ONCE per (lang, voice, phrase) and then served from disk. Each avoided
 * render is a whole ~4.2 s voice switch on a one-model-resident Piper. */
test('v1.47.6 — terminators render once, then come from cache (voice switches halved)', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    _resetTerminatorCacheForTest();
    const rendered: string[] = [];
    const renderTts = async (o: { text?: string; voice?: string }) => {
      rendered.push(`${o.voice}:${o.text}`);
      return { ok: true as const, wav: fakeWav(200), durationMs: 5 };
    };
    const opts = (msg: string) => ({
      ...baseOpts(klaxonDir, cacheDir), endOfMessage: true,
      message: msg,
      messages: [
        { text: msg, voice: 'en_US-lessac-medium', lang: 'en' as const },
        { text: `${msg} es`, voice: 'es_MX-ald-medium', lang: 'es' as const },
      ],
      renderTts,
    });
    // First announcement: 2 passes + 2 terminators = 4 renders.
    const r1 = await renderAnnouncement(opts('Alpha') as any);
    assert.equal(r1.ok, true);
    const firstTerminatorRenders = rendered.filter((x) => /End of message|Fin del mensaje/.test(x)).length;
    assert.equal(firstTerminatorRenders, 2, 'first announcement renders both terminators');

    // Second announcement with DIFFERENT message text (so passes re-render, but
    // the terminators must be served from the persistent cache).
    rendered.length = 0;
    _resetTerminatorCacheForTest(); // clear the in-memory memo — disk must still serve
    const r2 = await renderAnnouncement(opts('Bravo') as any);
    assert.equal(r2.ok, true);
    const secondTerminatorRenders = rendered.filter((x) => /End of message|Fin del mensaje/.test(x)).length;
    assert.equal(secondTerminatorRenders, 0, 'terminators served from disk cache — zero re-renders');
    // Only the two message passes hit Piper.
    assert.equal(rendered.length, 2, `expected only the 2 message passes, got ${rendered.length}`);
  });
});


/* v1.48.0 — boot-time terminator pre-warm. The phrases and voices are known at
 * startup, so the boot pays the (one-time) terminator renders in the background
 * and NO announcement ever renders one cold — even right after a voice change
 * or cache wipe. Proven: pre-warm renders each entry once, a later announcement
 * renders ONLY its message passes, and a second pre-warm is a pure no-op. */
test('v1.48.0 — boot pre-warm renders terminators once; alarms then render zero terminators', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    _resetTerminatorCacheForTest();
    const rendered: string[] = [];
    const renderTts = async (o: { text?: string; voice?: string }) => {
      rendered.push(`${o.voice}:${o.text}`);
      return { ok: true as const, wav: fakeWav(200), durationMs: 5 };
    };
    const entries = [
      { lang: 'es' as const, voice: 'es_MX-claude-high', phrase: 'Fin del mensaje' },
      { lang: 'en' as const, voice: 'en_US-lessac-medium', phrase: 'End of message' },
    ];
    const p1 = await prewarmTerminatorCache({ cacheDir, host: 'x', port: 1, entries, log: () => {}, renderTts: renderTts as any });
    assert.deepEqual({ rendered: p1.rendered, cached: p1.cached, failed: p1.failed }, { rendered: 2, cached: 0, failed: 0 });
    // Ordered as given: Spanish first, primary English LAST (left resident).
    assert.deepEqual(rendered.map((x) => x.split(':')[0]), ['es_MX-claude-high', 'en_US-lessac-medium']);

    // An announcement after pre-warm: only the 2 message passes hit the renderer,
    // even with the in-memory memo cleared (the DISK cache must serve — the
    // pre-warm wrote files under the same key the alarm path reads).
    rendered.length = 0;
    _resetTerminatorCacheForTest();
    const r = await renderAnnouncement({
      ...baseOpts(klaxonDir, cacheDir), endOfMessage: true,
      // Mirror production: broadcast.ts passes the Spanish phrase through, and the
      // pre-warm wiring uses the same `phraseEs || phrase` fallback — the keys must
      // agree END TO END or the pre-warm is useless.
      endOfMessagePhraseEs: 'Fin del mensaje',
      message: 'Alpha',
      messages: [
        { text: 'Alpha', voice: 'en_US-lessac-medium', lang: 'en' as const },
        { text: 'Alpha es', voice: 'es_MX-claude-high', lang: 'es' as const },
      ],
      renderTts,
    } as any);
    assert.equal(r.ok, true);
    assert.ok(!r.filename?.includes('.partial.'), 'terminators present → complete render');
    assert.equal(rendered.filter((x) => /End of message|Fin del mensaje/.test(x)).length, 0, 'no cold terminator render at alarm time');
    assert.equal(rendered.length, 2, `expected only the 2 message passes, got ${rendered.length}`);

    // Re-running the pre-warm (every boot) is two file stats, no renders.
    rendered.length = 0;
    const p2 = await prewarmTerminatorCache({ cacheDir, host: 'x', port: 1, entries, log: () => {}, renderTts: renderTts as any });
    assert.deepEqual({ rendered: p2.rendered, cached: p2.cached, failed: p2.failed }, { rendered: 0, cached: 2, failed: 0 });
    assert.equal(rendered.length, 0, 'warmed boot performs no renders');
  });
});

/* v1.48.0 review fixes — three defects the adversarial review confirmed. */

test('v1.48.0 — cached terminators do NOT corrupt resident-voice tracking (steady state stays ≤1 switch)', async () => {
  await withDirs(async (klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    _resetTerminatorCacheForTest();
    const order: string[] = [];
    const renderTts = async (o: { text?: string; voice?: string }) => {
      order.push(`${o.voice}`);
      return { ok: true as const, wav: fakeWav(200), durationMs: 5 };
    };
    const opts = (msg: string) => ({
      ...baseOpts(klaxonDir, cacheDir), endOfMessage: true, endOfMessagePhraseEs: 'Fin del mensaje',
      message: msg,
      messages: [
        { text: msg, voice: 'en-v', lang: 'en' as const },
        { text: `${msg} es`, voice: 'es-v', lang: 'es' as const },
      ],
      renderTts,
    });
    // Alarm 1: renders passes en,es + terminators (resident-first ordering of the
    // tails: after the es pass Piper holds es, so the es terminator renders first,
    // then the en terminator — Piper ends holding EN (the last actual render).
    await renderAnnouncement(opts('Alpha') as any);
    // Alarm 2: terminators now cached — only passes render, and the FIRST pass must
    // be the voice of the LAST ACTUAL RENDER of alarm 1 (the en terminator), not
    // whatever a cache hit claimed. Before this fix the cached tail loop falsely
    // stamped residentVoice, inverting the order and adding a cold switch.
    order.length = 0;
    await renderAnnouncement(opts('Bravo') as any);
    assert.deepEqual(order, ['en-v', 'es-v'], 'alarm 2 renders resident (en) first — 1 switch');
    // Alarm 3: after alarm 2's passes Piper holds es → es must come first now.
    order.length = 0;
    await renderAnnouncement(opts('Charlie') as any);
    assert.deepEqual(order, ['es-v', 'en-v'], 'alarm 3 renders resident (es) first — 1 switch');
  });
});

test('v1.48.0 — pruneRenderCache never deletes terminator cache files (they are permanent)', async () => {
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-prune-'));
  try {
    const old = new Date(Date.now() - 30 * 86_400_000); // far beyond any max age
    for (const name of ['term-abcdef0123456789.wav', 'deadbeef01234567.wav', `term-ffff.wav.123.aaaaaa.tmp`]) {
      writeFileSync(resolve(cacheDir, name), fakeWav(50));
      utimesSync(resolve(cacheDir, name), old, old);
    }
    const removed = await pruneRenderCache(cacheDir, 7 * 86_400_000, () => {});
    const left = readdirSync(cacheDir).sort();
    assert.equal(removed, 2, 'combined render + orphaned term tmp removed');
    assert.deepEqual(left, ['term-abcdef0123456789.wav'], 'terminator WAV survives; stale combined render and tmp orphan swept');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('v1.48.0 — pre-warm halts on the first failure (no follow-up request at a sick server)', async () => {
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'ef-halt-'));
  try {
    _resetResidentVoiceForTest();
    _resetTerminatorCacheForTest();
    let attempts = 0;
    const renderTts = async () => { attempts++; return { ok: false as const, error: 'wyoming render timeout' }; };
    const r = await prewarmTerminatorCache({
      cacheDir, host: 'x', port: 1,
      entries: [
        { lang: 'es', voice: 'es-v', phrase: 'Fin del mensaje' },
        { lang: 'en', voice: 'en-v', phrase: 'End of message' },
      ],
      log: () => {}, renderTts: renderTts as any,
    });
    assert.equal(attempts, 1, 'second entry never attempted after the first failed');
    assert.deepEqual({ rendered: r.rendered, cached: r.cached, failed: r.failed }, { rendered: 0, cached: 0, failed: 1 });
    assert.equal(existsSync(resolve(cacheDir, 'term-')) || readdirSync(cacheDir).length, 0, 'nothing persisted');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
