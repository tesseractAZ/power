import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderAnnouncement, prewarmTerminatorCache, pruneRenderCache, _resetResidentVoiceForTest, _resetTerminatorCacheForTest } from '../src/audioRenderer.js';
import { OPTIONS } from '../src/config.js';
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
  level: 'critical' as const,
  message: 'Critical alarm.',
  messages: [
    { text: 'Critical alarm.', voice: 'en_US-lessac-medium', lang: 'en' as const },
    { text: 'Alarma critica.', voice: 'es_MX-ald-medium', lang: 'es' as const },
  ],
  klaxonDir, cacheDir, wyomingHost: 'x', wyomingPort: 1,
  endOfMessage: false, // isolate the pass render order from terminators
  log: () => {},
});

/* ── v1.207.2 — a scripted speech engine on a mocked clock ─────────────────────────────────────────────────────
 * Each step is one attempt: how long the engine needs for it and how it ends. An attempt that needs more than the
 * limit it was handed ends the way the client ends it, with a timeout at that limit (`overrun` lets one run past
 * its limit, for the clamp to the remaining budget). `given` is the limit handed to the engine for each attempt, in
 * order: the figure these tests pin.
 * The clock moves across the pause before a retry too. The renderer's one timer is that pause (a setTimeout); while
 * an announcement is being rendered here, setTimeout advances the mocked clock by the delay it was asked for and
 * then fires at once, so a figure after a retry is the one an install sees (0.3 s later than the failure). `pause`
 * on the failed step makes that pause last longer on the clock: a timer the host was late to fire. */
type Step = { takes: number | 'limit'; ends: 'ok' | 'timeout' | 'socket'; overrun?: boolean; pause?: number };
interface Spoken { given: number[]; voices: string[]; ok: boolean; partial: boolean; elapsedMs: number }
const EN_VOICE = 'en_US-lessac-medium';
const ES_VOICE = 'es_MX-ald-medium';
/** The bilingual announcement broadcast.ts builds: English, then Spanish in the second voice. */
const TWO = {
  message: 'Critical alarm.',
  messages: [
    { text: 'Critical alarm.', voice: EN_VOICE, lang: 'en' as const },
    { text: 'Alarma critica.', voice: ES_VOICE, lang: 'es' as const },
  ],
};
/** One language: the single `message` (BROADCAST_BILINGUAL off, the shipped default). */
const ONE = { message: 'Critical alarm.', wyomingVoice: EN_VOICE };
/** Three passes. No caller builds them (broadcast.ts builds one or two); the rule counts every pass behind. */
const THREE = { message: 'Critical alarm.', messages: [...TWO.messages, { text: 'Third.', voice: 'third-voice', lang: 'en' as const }] };
const TTS_ENV = ['BROADCAST_TTS_PASS_TIMEOUT_MS', 'BROADCAST_TTS_TOTAL_BUDGET_MS'] as const;

/** Render one announcement against the scripted engine. `env` sets the two settings for this call only (a key
 *  left out is unset, the state of an install that never set the option); `before` runs in the same directories
 *  first, for a test that needs a voice left resident. */
async function speak(
  t: TestContext, opts: Record<string, unknown>, steps: Step[],
  env: Partial<Record<(typeof TTS_ENV)[number], string>> = {},
  before?: (klaxonDir: string, cacheDir: string) => Promise<void>,
): Promise<Spoken> {
  const saved = TTS_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of TTS_ENV) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  let out: Spoken | undefined;
  try {
    await withDirs(async (klaxonDir, cacheDir) => {
      _resetResidentVoiceForTest();
      _resetTerminatorCacheForTest();
      if (before) await before(klaxonDir, cacheDir);
      const t0 = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now: t0 });
      const realSetTimeout = globalThis.setTimeout;
      let last: Step | undefined;
      globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
        t.mock.timers.tick(last?.pause ?? ms ?? 0);
        return realSetTimeout(fn, 0, ...a);
      }) as unknown as typeof setTimeout;
      try {
        const given: number[] = [];
        const voices: string[] = [];
        const renderTts = async (o: { timeoutMs?: number; voice?: string }) => {
          // An attempt past the end of the script runs to its limit, so `given` shows every attempt made.
          const step: Step = steps[given.length] ?? { takes: 'limit', ends: 'timeout' };
          last = step;
          const limit = o.timeoutMs ?? -1;
          given.push(limit);
          voices.push(o.voice === EN_VOICE ? 'en' : o.voice === ES_VOICE ? 'es' : String(o.voice));
          const takes = step.takes === 'limit' ? limit : step.takes;
          if (!step.overrun && takes > limit) {
            t.mock.timers.tick(limit);
            return { ok: false as const, error: `wyoming render timeout after ${limit}ms` };
          }
          t.mock.timers.tick(takes);
          if (step.ends === 'ok') return { ok: true as const, wav: fakeWav(200), durationMs: takes };
          if (step.ends === 'socket') return { ok: false as const, error: 'wyoming socket: read ECONNRESET' };
          return { ok: false as const, error: `wyoming render timeout after ${limit}ms` };
        };
        const r = await renderAnnouncement({
          level: 'critical', klaxonDir, cacheDir, wyomingHost: 'x', wyomingPort: 1, endOfMessage: false, log: () => {},
          ...opts, renderTts,
        } as any);
        out = { given, voices, ok: r.ok, partial: !!r.filename?.includes('.partial.'), elapsedMs: Date.now() - t0 };
      } finally {
        globalThis.setTimeout = realSetTimeout;
        t.mock.timers.reset();
      }
    });
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return out!;
}

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
    // The limits are the defaults (12 s a pass, 25 s in all); the fake waits 120 ms and reports a timeout.
    const r = await renderAnnouncement({ ...baseOpts(klaxonDir, cacheDir), renderTts } as any);
    assert.equal(r.ok, false, 'all passes failed → hard error (caller falls back to chime-only)');
    // TWO passes, ONE attempt each — no retry after a timeout.
    assert.equal(attempts, 2, `expected 1 attempt per pass, got ${attempts}`);
  });
});

/* v1.207.2 — this test set BROADCAST_TTS_TOTAL_BUDGET_MS after the renderer was imported, where the value was
 * already fixed, so it ran on the 25 s default and its two bounds (under 20 s, at most 4 attempts) held for any
 * budget. The budget is read at each announcement now, and the test is exact: a 5 s budget, the clock mocked, the
 * limit of a pass left unset. The figures are v1.207.1's with the budget in its environment at start (5000, 4000,
 * 3000): at 12 s no reserve is held, so the first pass has the whole 5 s. */
test('v1.47.5 — the spoken phase is budget-bounded: passes and terminators stop at BROADCAST_TTS_TOTAL_BUDGET_MS', async (t) => {
  const o = await speak(t, { ...TWO, endOfMessage: true, endOfMessagePhraseEs: 'Fin del mensaje' }, [
    { takes: 1_000, ends: 'ok' },          // English: the 5 s the budget has (under the 12 s limit)
    { takes: 1_000, ends: 'ok' },          // Spanish: the 4 s that are left
    { takes: 'limit', ends: 'timeout' },   // the first terminator runs through the last 3 s
  ], { BROADCAST_TTS_TOTAL_BUDGET_MS: '5000' });
  assert.deepEqual(o.given, [5_000, 4_000, 3_000], 'every limit is inside the 5 s budget; the second terminator is not attempted');
  assert.equal(o.elapsedMs, 5_000, 'the spoken phase ends at its budget');
  assert.equal(o.ok, true, 'both passes rendered');
  assert.equal(o.partial, true, 'the terminators were lost to the budget: served, not cached as complete');
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

/* v1.187.10 (log review 10-03, C31) — the bilingual pre-warm runs one job per language
 * (broadcast.ts), and its two "0 rendered, 1 already cached" summaries were byte-identical. */
test('v1.187.10 — the per-language pre-warm summaries say which language they are', async () => {
  await withDirs(async (_klaxonDir, cacheDir) => {
    _resetResidentVoiceForTest();
    _resetTerminatorCacheForTest();
    const renderTts = async () => ({ ok: true as const, wav: fakeWav(200), durationMs: 5 });
    const lines: string[] = [];
    for (const entry of [
      { lang: 'es' as const, voice: 'es_MX-claude-high', phrase: 'Fin del mensaje' },
      { lang: 'en' as const, voice: 'en_US-lessac-medium', phrase: 'End of message' },
    ]) {
      await prewarmTerminatorCache({ cacheDir, host: 'x', port: 1, entries: [entry], log: (m) => lines.push(m), renderTts: renderTts as any });
    }
    assert.deepEqual(lines, [
      'audioRenderer: terminator pre-warm (es) — 1 rendered, 0 already cached',
      'audioRenderer: terminator pre-warm (en) — 1 rendered, 0 already cached',
    ]);
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

/* ── v1.207.2 — the limit of a spoken pass is an add-on option, and a pass still to render keeps a reserve ───────
 * On 2026-11-17 a critical alarm lost its English pass to the 12 s limit: the sentence took longer to render, so
 * the tones and the Spanish pass were all that played. The limit (BROADCAST_TTS_PASS_TIMEOUT_MS, 3000..60000) is
 * an option now and its default stays 12000. Nothing plays until the spoken phase ends, so a longer limit is a
 * longer wait for the first sound when the engine stalls; and without a guard a long first pass would take the
 * time the other language needs. With the limit set above 12000, the limit handed to the engine for an attempt,
 * with m passes still to render after this one and R ms left of the 25 s budget, is
 *       min(limit, R, max(R − m × 8000, 3000))
 * (audioRenderer.ts attemptLimitMs). At 12000 or under, and wherever m is 0, it is min(limit, R): what v1.207.1
 * handed. A terminator is rendered after the passes, with m = 0. */

/** INVARIANT 1's table. `given` is what v1.207.1 hands the engine on each path: measured by driving this same
 *  script against the v1.207.1 renderer (commit 1d8bd05d). */
const UNSET_CASES: Array<{ path: string; opts: Record<string, unknown>; steps: Step[]; want: Spoken }> = [
  { path: 'two languages: every attempt runs to its limit', opts: TWO,
    steps: [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000], voices: ['en', 'es'], ok: false, partial: false, elapsedMs: 24_000 } },
  { path: 'two languages: the first returns late (OK at 11.9 s), the second OK at 4 s', opts: TWO,
    steps: [{ takes: 11_900, ends: 'ok' }, { takes: 4_000, ends: 'ok' }],
    want: { given: [12_000, 12_000], voices: ['en', 'es'], ok: true, partial: false, elapsedMs: 15_900 } },
  { path: 'two languages: the first fails at 18 s, past its limit; the second has the 7 s the budget has left', opts: TWO,
    steps: [{ takes: 18_000, ends: 'timeout', overrun: true }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 7_000], voices: ['en', 'es'], ok: false, partial: false, elapsedMs: 25_000 } },
  { path: 'two languages: a socket drop at 2.9 s, then the retry and the second run to their limits', opts: TWO,
    steps: [{ takes: 2_900, ends: 'socket' }, { takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000, 9_800], voices: ['en', 'en', 'es'], ok: false, partial: false, elapsedMs: 25_000 } },
  { path: 'two languages: a socket drop at 2.9 s, the retry OK at 5 s, the second OK at 4 s', opts: TWO,
    steps: [{ takes: 2_900, ends: 'socket' }, { takes: 5_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }],
    want: { given: [12_000, 12_000, 12_000], voices: ['en', 'en', 'es'], ok: true, partial: false, elapsedMs: 12_200 } },
  { path: 'two languages: the 2026-11-17 shape (English needs 14 s, Spanish 4 s): English is lost at 12 s, as it was', opts: TWO,
    steps: [{ takes: 14_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }],
    want: { given: [12_000, 12_000], voices: ['en', 'es'], ok: true, partial: true, elapsedMs: 16_000 } },
  { path: 'two languages with terminators: passes OK at 5 s and 4 s, a terminator takes 9 s, the other has the 7 s left',
    opts: { ...TWO, endOfMessage: true, endOfMessagePhraseEs: 'Fin del mensaje' },
    steps: [{ takes: 5_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }, { takes: 9_000, ends: 'ok' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000, 12_000, 7_000], voices: ['en', 'es', 'es', 'en'], ok: true, partial: true, elapsedMs: 25_000 } },
  { path: 'one language: the attempt runs to its limit', opts: ONE,
    steps: [{ takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000], voices: ['en'], ok: false, partial: false, elapsedMs: 12_000 } },
  { path: 'one language with a terminator: the pass returns late (OK at 11.9 s), the terminator runs to its limit', opts: { ...ONE, endOfMessage: true },
    steps: [{ takes: 11_900, ends: 'ok' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000], voices: ['en', 'en'], ok: true, partial: true, elapsedMs: 23_900 } },
  { path: 'one language: a socket drop at 2.9 s, then the retry runs to its limit', opts: ONE,
    steps: [{ takes: 2_900, ends: 'socket' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000], voices: ['en', 'en'], ok: false, partial: false, elapsedMs: 15_200 } },
  // The host fires the 0.3 s pause late (2.5 s on the clock): 19.6 s are left, and the retry still has its 12 s.
  { path: 'two languages: a socket drop at 2.9 s, the pause before the retry lasts 2.5 s, the retry OK at 11.9 s, the second OK at 4 s', opts: TWO,
    steps: [{ takes: 2_900, ends: 'socket', pause: 2_500 }, { takes: 11_900, ends: 'ok' }, { takes: 4_000, ends: 'ok' }],
    want: { given: [12_000, 12_000, 7_700], voices: ['en', 'en', 'es'], ok: true, partial: false, elapsedMs: 21_300 } },
  { path: 'three passes: every attempt runs to its limit; the third has the 1 s the budget has left', opts: THREE,
    steps: [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 12_000, 1_000], voices: ['en', 'es', 'third-voice'], ok: false, partial: false, elapsedMs: 25_000 } },
  // The pause outlasts the budget (30 s on the clock): the retry is handed 0 and ends at once.
  { path: 'one language: a socket drop at 2.9 s, the pause before the retry outlasts the budget; the retry is handed 0', opts: ONE,
    steps: [{ takes: 2_900, ends: 'socket', pause: 30_000 }, { takes: 'limit', ends: 'timeout' }],
    want: { given: [12_000, 0], voices: ['en', 'en'], ok: false, partial: false, elapsedMs: 32_900 } },
];

test('★★★ v1.207.2 INVARIANT 1 — with the option unset, every limit handed to the speech engine is the one v1.207.1 handed it (one language, two, and three passes; every path)', async (t) => {
  const got: Record<string, Spoken> = {};
  for (const c of UNSET_CASES) got[c.path] = await speak(t, c.opts, c.steps);
  assert.deepEqual(got, Object.fromEntries(UNSET_CASES.map((c) => [c.path, c.want])));
});

test('★★★ v1.207.2 — at 20000 the 2026-11-17 shape keeps both languages: English OK at 14 s inside a 17 s limit, Spanish OK at 4 s', async (t) => {
  const o = await speak(t, TWO, [{ takes: 14_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }], { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(o.given, [17_000, 11_000], 'the first-rendered pass: 25 s less the 8 s reserve; the second: what is left');
  assert.deepEqual(o.voices, ['en', 'es']);
  assert.equal(o.ok, true);
  assert.equal(o.partial, false, 'both languages survive: a complete render, not a partial one');
  assert.equal(o.elapsedMs, 18_000, 'the first sound waits 18 s for the speech');
});

test('★★★ v1.207.2 INVARIANT 2 — at 20000 with two languages the first-rendered pass is handed 17000 and the other keeps 8000, whichever language renders first', async (t) => {
  const at20 = { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' };
  // English never returns: it is cut at 17 s, Spanish has its 8 s and renders in 4. One language is spoken.
  const lost = await speak(t, TWO, [{ takes: 'limit', ends: 'timeout' }, { takes: 4_000, ends: 'ok' }], at20);
  assert.deepEqual(lost.given, [17_000, 8_000]);
  assert.deepEqual(lost.voices, ['en', 'es']);
  assert.equal(lost.ok, true, 'the announcement keeps one language');
  assert.equal(lost.partial, true, 'a dropped pass: served, not cached as complete');
  assert.equal(lost.elapsedMs, 21_000);
  // Nothing returns: 17 s, then 8 s. The tones alone start at the 25 s budget.
  const none = await speak(t, TWO, [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }], at20);
  assert.deepEqual(none.given, [17_000, 8_000]);
  assert.equal(none.ok, false, 'no pass rendered: the caller falls back to the tones alone');
  assert.equal(none.elapsedMs, 25_000);
  // The Spanish voice is resident (the last announcement ended on it), so Spanish renders first: the reserve is
  // then the English pass's.
  const esFirst = await speak(t, TWO, [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }], at20,
    async (klaxonDir, cacheDir) => {
      const r = await renderAnnouncement({
        ...baseOpts(klaxonDir, cacheDir), message: 'Earlier.',
        messages: [{ text: 'Earlier.', voice: EN_VOICE, lang: 'en' as const }, { text: 'Antes.', voice: ES_VOICE, lang: 'es' as const }],
        renderTts: async () => ({ ok: true as const, wav: fakeWav(200), durationMs: 5 }),
      } as any);
      assert.equal(r.ok, true);
    });
  assert.deepEqual(esFirst.voices, ['es', 'en']);
  assert.deepEqual(esFirst.given, [17_000, 8_000]);
});

test('★★★ v1.207.2 — at 20000 a socket drop then a stalled retry: the retry is handed 13800, and the other language still has its 8000', async (t) => {
  const at20 = { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' };
  const o = await speak(t, TWO, [{ takes: 2_900, ends: 'socket' }, { takes: 'limit', ends: 'timeout' }, { takes: 4_000, ends: 'ok' }], at20);
  assert.deepEqual(o.given, [17_000, 13_800, 8_000], 'the retry: the 21.8 s left (25 less the 2.9 s failure and the 0.3 s pause) less the 8 s reserve');
  assert.deepEqual(o.voices, ['en', 'en', 'es']);
  assert.equal(o.ok, true, 'Spanish is spoken');
  assert.equal(o.partial, true);
  assert.equal(o.elapsedMs, 21_000);
  // The retry returns: what it did not use goes to the other language.
  const back = await speak(t, TWO, [{ takes: 2_900, ends: 'socket' }, { takes: 5_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }], at20);
  assert.deepEqual(back.given, [17_000, 13_800, 16_800]);
  assert.equal(back.partial, false);
});

test('★★ v1.207.2 — at 20000 a retry whose pause outlasted the budget is handed 0, never a negative limit, and the other language is not attempted', async (t) => {
  const o = await speak(t, TWO, [{ takes: 2_900, ends: 'socket', pause: 30_000 }, { takes: 'limit', ends: 'timeout' }, { takes: 4_000, ends: 'ok' }],
    { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(o.given, [17_000, 0], 'the retry is handed 0 (the client ends it at once), as in v1.207.1; nothing is attempted on a spent budget');
  assert.deepEqual(o.voices, ['en', 'en']);
  assert.equal(o.ok, false, 'no pass rendered: the tones alone');
});

test('★★ v1.207.2 — each pass still to render holds its own 8 s: three passes are handed 9000, 8000, 8000 at 20000, and at any limit above 12000', async (t) => {
  const stall: Step[] = [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }];
  const twenty = await speak(t, THREE, stall, { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(twenty.given, [9_000, 8_000, 8_000], '25 − 2 × 8 for the first; then 16 − 8; then the 8 s that are left');
  assert.deepEqual(twenty.voices, ['en', 'es', 'third-voice']);
  assert.equal(twenty.elapsedMs, 25_000);
  // The guard applies from 12001 up. At 12000 (INVARIANT 1, the three-pass row) the same script is handed 12000, 12000, 1000.
  const justAbove = await speak(t, THREE, stall, { BROADCAST_TTS_PASS_TIMEOUT_MS: '12001' });
  assert.deepEqual(justAbove.given, [9_000, 8_000, 8_000]);
  const atDefault = await speak(t, THREE, stall, { BROADCAST_TTS_PASS_TIMEOUT_MS: '12000' });
  assert.deepEqual(atDefault.given, [12_000, 12_000, 1_000], 'set to 12000, as unset: no reserve');
});

test('★★ v1.207.2 — only a pass still to render holds a reserve: a repeat of the pass in hand, or of one already rendered, holds none', async (t) => {
  const at20 = { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' };
  // The same pass twice is rendered once: nothing is behind it.
  const twice = await speak(t, { message: 'Critical alarm.', messages: [TWO.messages[0], TWO.messages[0]] }, [{ takes: 'limit', ends: 'timeout' }], at20);
  assert.deepEqual(twice.given, [20_000]);
  // English, Spanish, English again: English has Spanish behind it (17 s); Spanish has only a pass that has
  // already rendered behind it, so it is handed the 20 s that are left.
  const again = await speak(t, { message: 'Critical alarm.', messages: [TWO.messages[0], TWO.messages[1], TWO.messages[0]] },
    [{ takes: 5_000, ends: 'ok' }, { takes: 'limit', ends: 'timeout' }], at20);
  assert.deepEqual(again.given, [17_000, 20_000]);
  assert.deepEqual(again.voices, ['en', 'es']);
});

test('★★ v1.207.2 — one language has nothing to reserve for: 20000 is handed 20000, and a limit above the budget the 25 s the budget has', async (t) => {
  const twenty = await speak(t, ONE, [{ takes: 'limit', ends: 'timeout' }], { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(twenty.given, [20_000]);
  assert.equal(twenty.ok, false);
  assert.equal(twenty.elapsedMs, 20_000, 'what the longer limit costs one language: the tones alone at 20 s, not 12');
  const sixty = await speak(t, ONE, [{ takes: 'limit', ends: 'timeout' }], { BROADCAST_TTS_PASS_TIMEOUT_MS: '60000' });
  assert.deepEqual(sixty.given, [25_000], 'clamped to the remaining budget');
  assert.equal(sixty.elapsedMs, 25_000);
  // A single entry in `messages` is one pass too.
  const single = await speak(t, { message: 'Critical alarm.', messages: [TWO.messages[0]] }, [{ takes: 'limit', ends: 'timeout' }], { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(single.given, [20_000]);
});

test('★★ v1.207.2 — a terminator has the limit or what is left, and no reserve is held for one (at 20000: 17000, 20000, 16000, 7000)', async (t) => {
  const o = await speak(t, { ...TWO, endOfMessage: true, endOfMessagePhraseEs: 'Fin del mensaje' },
    [{ takes: 5_000, ends: 'ok' }, { takes: 4_000, ends: 'ok' }, { takes: 9_000, ends: 'ok' }, { takes: 'limit', ends: 'timeout' }],
    { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(o.given, [17_000, 20_000, 16_000, 7_000]);
  assert.deepEqual(o.voices, ['en', 'es', 'es', 'en']);
  assert.equal(o.elapsedMs, 25_000);
  // One language with no voice named (the shipped default): the terminator is not kept across a restart, so it is
  // rendered with an announcement. The pass is ready at 1 s and the terminator never returns: the speech waits
  // for the terminator's limit as well.
  const oneLanguage = { message: 'Critical alarm.', endOfMessage: true };
  const stalledTerminator: Step[] = [{ takes: 1_000, ends: 'ok' }, { takes: 'limit', ends: 'timeout' }];
  const unset = await speak(t, oneLanguage, stalledTerminator);
  assert.deepEqual(unset.given, [12_000, 12_000]);
  assert.equal(unset.elapsedMs, 13_000, 'by default: the speech, without its terminator, at 13 s');
  const twenty = await speak(t, oneLanguage, stalledTerminator, { BROADCAST_TTS_PASS_TIMEOUT_MS: '20000' });
  assert.deepEqual(twenty.given, [20_000, 20_000]);
  assert.equal(twenty.elapsedMs, 21_000, 'at 20000: at 21 s');
  assert.equal(twenty.ok, true);
  assert.equal(twenty.partial, true, 'the terminator was lost: served, not cached as complete');
});

test('★★ v1.207.2 — a value outside 3000..60000, or not a number, reads as 12000; the option row reads what the renderer reads', async (t) => {
  // The budget is raised so that a limit up to 60000 is handed whole (one language: no reserve).
  const handed = async (raw: string | undefined) => (await speak(t, ONE, [{ takes: 0, ends: 'timeout' }],
    { BROADCAST_TTS_TOTAL_BUDGET_MS: '120000', ...(raw === undefined ? {} : { BROADCAST_TTS_PASS_TIMEOUT_MS: raw }) })).given;
  const want: Array<[string | undefined, number]> = [
    [undefined, 12_000], ['', 12_000], ['null', 12_000], ['abc', 12_000], ['12 s', 12_000], ['NaN', 12_000], ['Infinity', 12_000],
    ['-20000', 12_000], ['0', 12_000], ['2999', 12_000], ['60001', 12_000], ['600000', 12_000],
    ['3000', 3_000], ['12000', 12_000], ['20000', 20_000], ['60000', 60_000],
  ];
  for (const [raw, ms] of want) assert.deepEqual(await handed(raw), [ms], `${JSON.stringify(raw)} is handed to the engine as ${ms}`);
  // config.ts registers the option with the same rule (the renderer reads the variable itself).
  const row = OPTIONS.BROADCAST_TTS_PASS_TIMEOUT_MS;
  assert.ok(row, 'BROADCAST_TTS_PASS_TIMEOUT_MS has an OPTIONS row');
  for (const [raw, ms] of want) assert.equal(row.parse(raw, { get: () => undefined }), ms, `${JSON.stringify(raw)}: the option row`);
});

test('★★ v1.207.2 — the floor: when the reserve would leave a pass under 3 s it is handed 3 s, or what is left of the budget if that is less (at 20000)', async (t) => {
  // The limit is 20000 throughout: at 12000 or under no reserve is held, so there is nothing to floor.
  const at20 = (budget: string) => ({ BROADCAST_TTS_PASS_TIMEOUT_MS: '20000', BROADCAST_TTS_TOTAL_BUDGET_MS: budget });
  // A 5 s budget (the least the setting accepts), two languages: 5 − 8 is negative, so the first pass has the 3 s
  // floor and the second the 2 s that are left.
  const five = await speak(t, TWO, [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }], at20('5000'));
  assert.deepEqual(five.given, [3_000, 2_000]);
  assert.equal(five.elapsedMs, 5_000, 'never past the budget');
  // Three passes: the second has 2 s left and one pass after it. It is handed the 2 s, not the floor (the limit
  // never exceeds what is left), and the third is not attempted on a spent budget.
  const three = await speak(t, THREE, [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }], at20('5000'));
  assert.deepEqual(three.given, [3_000, 2_000]);
  assert.ok(three.given.every((ms) => ms > 0), 'no attempt is handed zero or less');
  assert.equal(three.elapsedMs, 5_000);
  // A 12 s budget: the reserve leaves the first pass 4 s and the second has its 8 s.
  const twelve = await speak(t, TWO, [{ takes: 'limit', ends: 'timeout' }, { takes: 'limit', ends: 'timeout' }], at20('12000'));
  assert.deepEqual(twelve.given, [4_000, 8_000]);
  assert.equal(twelve.elapsedMs, 12_000);
});
