/**
 * v0.9.70 — Announcement renderer.
 *
 * Combines a klaxon WAV (synthesized at startup by audioAssets.ts) with
 * a TTS WAV (rendered on demand by wyomingTts.ts) into a single
 * announcement WAV. Caches the result on disk so repeated identical
 * announcements skip the render entirely.
 *
 * Layout:
 *
 *     ┌─────────────┬───────────────────────┬────────────────────────────────────┐
 *     │ lead-in gap │ klaxon × N (default 2) │ piper TTS rendering of the message │
 *     └─────────────┴───────────────────────┴────────────────────────────────────┘
 *      ~1.0 s silent  ~1.4 s (yellow/green)   ~0.5–6 s depending on message length
 *      (default)      ~3.0 s (red), × N       (N = getChimeRepeat(), part of cache key)
 *
 * Why the lead-in gap (v0.12.1):
 *
 *   - Multi-room players — AirPlay devices especially (e.g. Ecobee
 *     thermostats exposed as Music Assistant AirPlay players) — take a
 *     beat to establish the audio stream when an announcement starts. With
 *     no lead-in, the first fraction of the chime is clipped on every
 *     speaker, and the SLOWEST device can still be negotiating when a short
 *     clip ends → it plays nothing at all and seems to "miss" the alert.
 *   - Prepending leadSilenceMs of digital silence (zero-filled PCM, frame-
 *     aligned to the WAV format) gives every speaker time to sync up before
 *     any meaningful audio. It is part of the cache key, so changing the
 *     amount re-renders automatically. leadSilenceMs = 0 disables it.
 *
 * Why combine into one WAV instead of two play_announcement calls:
 *
 *   - Music Assistant's play_announcement serializes per target — back-
 *     to-back calls hit a queue that needs ~5–8 sec to clear (the
 *     v0.9.43 wait window). Combining into one call eliminates that
 *     entire class of race condition.
 *   - One render = one cache hit on the wire. The HomePod/Sonos
 *     downloads the URL once and gets the full sequence.
 *   - Speaker volume + restore is atomic for the whole announcement.
 *
 * Why cache:
 *
 *   - Repeated alerts (same level, same message — e.g. the same offline-
 *     device alert re-firing every 10 min) skip the Wyoming roundtrip.
 *   - Cache key = sha1(version || level || chimeRepeat || message), so a
 *     message change OR a chime-repeat change busts the cache automatically.
 *   - Per-render version prefix in the key lets us invalidate every
 *     cached file by bumping the constant (without touching disk).
 *
 * Why not resample on mismatched sample rates:
 *
 *   - Piper's default voice (en_US-amy-medium) produces 22050 Hz mono
 *     16-bit, which matches audioAssets.ts exactly. Concat is a
 *     byte-splice — no resampling math, no quality loss.
 *   - If a user picks a Piper voice with a different sample rate,
 *     concat returns null and the caller falls back to klaxon-only.
 *     The alternative — implementing linear-interp resampling in JS —
 *     adds complexity that isn't paying for itself yet. Revisit if
 *     anyone actually hits this.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, access, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { renderWyomingTts, pcmToWav } from './wyomingTts.js';
import { verbalizeForTts, verbalizeForTtsEs } from './ttsService.js';
import { getChimeRepeat } from './alertSettings.js';
import { AUDIO_ASSETS_VERSION } from './audioAssets.js';

/* ── v1.44.0 — TTS render health (the dead-voice self-alert) ────────────────
 * A wedged Piper renders nothing while cached WAVs keep playing, so a dead
 * voice can hide behind the cache for days (observed: 27 h, exposed only when
 * a retitle forced the first fresh render). This holder counts consecutive
 * FAILED render requests (a request fails when every spoken pass fails);
 * cached deliveries prove nothing about render health and do not touch it.
 * A fresh successful render resets the counter, auto-resolving the alert. */
export interface TtsRenderHealth {
  consecutiveFailures: number;
  lastFailureMs: number | null;
  lastFailureReason: string | null;
  lastSuccessMs: number | null;
}
let ttsHealth: TtsRenderHealth = { consecutiveFailures: 0, lastFailureMs: null, lastFailureReason: null, lastSuccessMs: null };
export function ttsRenderHealth(): TtsRenderHealth { return { ...ttsHealth }; }
export function noteTtsRenderFailure(reason: string, now: number = Date.now()): void {
  ttsHealth = { consecutiveFailures: ttsHealth.consecutiveFailures + 1, lastFailureMs: now, lastFailureReason: reason, lastSuccessMs: ttsHealth.lastSuccessMs };
}
export function noteTtsRenderSuccess(now: number = Date.now()): void {
  ttsHealth = { consecutiveFailures: 0, lastFailureMs: ttsHealth.lastFailureMs, lastFailureReason: null, lastSuccessMs: now };
}
export function _resetTtsHealthForTest(): void {
  ttsHealth = { consecutiveFailures: 0, lastFailureMs: null, lastFailureReason: null, lastSuccessMs: null };
}

/* ── v1.47.5 — spoken-render reliability AND bounded alarm latency ─────────
 * Piper keeps ONE voice resident and cold-loads on each switch, so a bilingual
 * alarm (2 passes + 2 terminators) can pay several loads. When the HOST is
 * CPU-starved (observed live: load ~5 on 4 cores, Piper 6-10x slower than
 * spec) those renders exceed any per-pass timeout, and v1.47.4's blanket
 * retry turned that into a 151-SECOND alarm — unacceptable on a life-safety
 * path, where the chime must sound promptly and speech is the bonus.
 *
 * Two rules, both about bounding damage:
 *   1. TOTAL BUDGET for the whole spoken phase. Once spent, no further pass or
 *      terminator is attempted; whatever rendered is used, else the caller's
 *      chime-only fallback fires. Alarm latency is bounded regardless of how
 *      sick Piper is.
 *   2. RETRY ONLY FAST FAILURES. A socket error (Piper restarting / dropping
 *      mid-stream) is transient and cheap to retry. A TIMEOUT means Piper is
 *      wedged or starved — retrying just burns the budget a second time and
 *      adds another aborted socket, and aborted sockets are what crash Piper
 *      (observed: 55 BrokenPipeError, 3 "Server stopped" in one afternoon). */
const PASS_TIMEOUT_MS = (() => {
  const v = Number(process.env.BROADCAST_TTS_PASS_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 3000 && v <= 60000 ? v : 12000;
})();
/** Whole-spoken-phase budget (passes + terminators). Bounds alarm latency. */
const SPOKEN_BUDGET_MS = (() => {
  const v = Number(process.env.BROADCAST_TTS_TOTAL_BUDGET_MS);
  return Number.isFinite(v) && v >= 5000 && v <= 120000 ? v : 25000;
})();
/** A failure this fast is a socket/stream error, not a wedged server — retry it. */
const FAST_FAIL_MS = 3000;
const PASS_RETRY_DELAY_MS = 300;
/** The voice Piper most recently rendered (module state; renders are serialized
 *  by the broadcast single-flight, and a cache hit — which never touches Piper
 *  — leaves this unchanged, matching Piper's actual resident model). */
let residentVoice = '';
export function _resetResidentVoiceForTest(): void { residentVoice = ''; }
/** Order render specs so the resident voice's items come first (0 reloads),
 *  then group remaining items by voice so each voice loads at most once. */
function residentFirst<T extends { voice?: string }>(specs: T[]): T[] {
  return [...specs].sort((a, b) => {
    const ar = (a.voice ?? '') === residentVoice, br = (b.voice ?? '') === residentVoice;
    return ar === br ? 0 : ar ? -1 : 1;
  });
}
/**
 * Render one spoken item within the remaining budget. Returns `null` when the
 * budget is already spent (caller drops the item without touching Piper).
 * Retries once ONLY when the first failure was fast (socket error) and budget
 * remains — never after a timeout.
 */
async function renderWithinBudget(
  render: typeof renderWyomingTts,
  host: string, port: number, text: string, voice: string | undefined,
  deadline: number, log: (m: string) => void, label: string,
) {
  const remaining = () => deadline - Date.now();
  if (remaining() <= 0) {
    log(`audioRenderer: ${label} skipped — spoken-render budget spent (alarm latency bound)`);
    return null;
  }
  const t0 = Date.now();
  let r = await render({ host, port, text, voice, timeoutMs: Math.min(PASS_TIMEOUT_MS, remaining()) });
  if (!r.ok || !r.wav) {
    const elapsed = Date.now() - t0;
    // A timeout is identified BOTH ways — by the wall clock and by the reported
    // error — because neither alone is reliable: a renderer can report a timeout
    // promptly, and a slow socket error is still a socket error.
    const timedOut = elapsed >= FAST_FAIL_MS || /timeout/i.test(r.error ?? '');
    const fastFail = !timedOut;
    if (fastFail && remaining() > FAST_FAIL_MS) {
      log(`audioRenderer: ${label} failed fast (${r.error ?? 'unknown'}) after ${elapsed}ms — retrying once`);
      await new Promise((res) => setTimeout(res, PASS_RETRY_DELAY_MS));
      r = await render({ host, port, text, voice, timeoutMs: Math.min(PASS_TIMEOUT_MS, Math.max(0, remaining())) });
    } else if (timedOut) {
      log(`audioRenderer: ${label} timed out after ${elapsed}ms — NOT retrying (server wedged/starved; retry would double the delay and abort another socket)`);
    }
  }
  return r;
}

/**
 * v1.47.6 — PERSISTENT terminator cache. The "End of message" / "Fin del
 * mensaje" phrases NEVER change, yet every fresh announcement re-rendered them
 * — and each one costs a full voice switch (~4.2 s measured; Piper keeps one
 * model resident, so the cost is the model load, not the phrase length). A
 * bilingual alarm therefore paid up to FOUR loads. Caching the terminator PCM
 * on disk removes two of them permanently: after the first render the
 * terminators are free forever, so a bilingual alarm costs one voice switch.
 *
 * Keyed on RENDER_VERSION + lang + voice + phrase + PCM format, so changing
 * any of them re-renders rather than serving stale audio.
 */
const terminatorMemo = new Map<string, Buffer>();
export function _resetTerminatorCacheForTest(): void { terminatorMemo.clear(); }
/** v1.48.0 — the on-disk key deliberately EXCLUDES the PCM format: a chime whose
 *  format differs from Piper's output breaks the spoken path outright (pass
 *  format-mismatch), so exactly one format is ever viable per install. Reads
 *  validate the header against the requested format anyway (a wrong-format file
 *  is a cache miss that gets re-rendered and overwritten), and dropping fmt from
 *  the key is what lets the boot pre-warm write usable entries without knowing
 *  the chime format. The in-memory memo keeps fmt in ITS key because memo hits
 *  skip that read-time validation. */
function terminatorKey(lang: 'en' | 'es', voice: string | undefined, phrase: string): string {
  return createHash('sha1')
    .update(`term|v${RENDER_VERSION}|${lang}|${voice ?? ''}|${phrase}`)
    .digest('hex').slice(0, 16);
}
/** Persist a terminator WAV (atomic tmp+rename, unpredictable temp name — same
 *  hardening as the render cache). Best-effort: a failed write only means the
 *  next announcement re-renders. */
async function persistTerminatorWav(cacheDir: string, file: string, wav: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tmp, wav, { flag: 'wx' });
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => { /* best effort */ });
  }
}
async function terminatorPcm(opts: {
  cacheDir: string; host: string; port: number; phrase: string; spoken: string;
  voice?: string; lang: 'en' | 'es'; fmt: { rate: number; width: number; channels: number };
  render: typeof renderWyomingTts; deadline: number; log: (m: string) => void;
}): Promise<{ pcm: Buffer | null; dropped: boolean }> {
  const { cacheDir, host, port, phrase, spoken, voice, lang, fmt, render, deadline, log } = opts;
  const key = terminatorKey(lang, voice, phrase);
  const memoKey = `${key}|${fmt.rate}/${fmt.width}/${fmt.channels}`;
  const memo = terminatorMemo.get(memoKey);
  if (memo) return { pcm: memo, dropped: false };
  // v1.48.0 — the DISK cache is only used when the voice is explicitly pinned.
  // With voice unset the rendered audio depends on the TTS server's configured
  // default voice, which can change without touching this add-on — a persisted
  // file would then serve the OLD voice forever. The in-memory memo is safe
  // (cleared on restart, and a server voice change requires its restart too).
  const pinned = (voice ?? '').length > 0;
  const file = resolve(cacheDir, `term-${key}.wav`);
  if (pinned) {
    try {
      const wav = await readFile(file);
      const h = parseWavHeader(wav);
      if (h.ok && h.rate === fmt.rate && h.width === fmt.width && h.channels === fmt.channels
        && h.dataOffset + h.dataLength <= wav.length) {
        const pcm = wav.subarray(h.dataOffset, h.dataOffset + h.dataLength);
        terminatorMemo.set(memoKey, pcm);
        return { pcm, dropped: false };
      }
    } catch { /* not cached yet — render it below */ }
  }
  const r = await renderWithinBudget(render, host, port, spoken, voice, deadline, log, `terminator (lang=${lang})`);
  if (r == null) return { pcm: null, dropped: true };
  if (!r.ok || !r.wav) {
    log(`audioRenderer: terminator render failed (${r.error ?? 'unknown'}) — omitting it (message still plays)`);
    return { pcm: null, dropped: true };
  }
  const h = parseWavHeader(r.wav);
  if (!h.ok || h.rate !== fmt.rate || h.width !== fmt.width || h.channels !== fmt.channels) {
    log('audioRenderer: terminator format mismatch — omitting it (message still plays)');
    return { pcm: null, dropped: true };
  }
  const pcm = r.wav.subarray(h.dataOffset, h.dataOffset + h.dataLength);
  // v1.48.0 — the render genuinely touched Piper, so IT owns the resident-voice
  // update. The caller must not stamp on cache hits (which never touch Piper) —
  // that inverted the tracking and made every steady-state bilingual alarm pay
  // an extra voice switch.
  residentVoice = voice ?? '';
  terminatorMemo.set(memoKey, pcm);
  // Persist so the cost is paid ONCE for the lifetime of the install (pinned
  // voices only — see above).
  if (pinned) await persistTerminatorWav(cacheDir, file, r.wav);
  return { pcm, dropped: false };
}

/** v1.48.0 — pre-warm render budget. Tighter than first drafted: the pre-warm
 *  runs on the broadcast single-flight chain, so its in-flight render is the
 *  MOST an alarm can wait behind. A cold model load is ~4.2 s + ~1 s synthesis;
 *  8 s is ample for a healthy server, and a server that can't make it is sick —
 *  the pre-warm halts rather than fire more requests at it. */
const PREWARM_TIMEOUT_MS = 8_000;

/**
 * v1.48.0 — boot-time terminator pre-warm. The terminator phrases and voices
 * are fully known at startup, so rendering them ONCE in the background (and
 * persisting via the same cache the alarm path reads) means no announcement
 * ever pays a cold terminator render — even right after a voice change, a
 * RENDER_VERSION bump, or a cache wipe. With terminators always cached, the
 * resident-first pass ordering bounds a fresh bilingual alarm at ONE voice
 * switch regardless of which voices are configured.
 *
 * Entries render in the given order — put the PRIMARY voice last so Piper is
 * left holding it. Failures are logged and skipped (the alarm path falls back
 * to rendering on demand, exactly as before this existed).
 */
export async function prewarmTerminatorCache(opts: {
  cacheDir: string; host: string; port: number;
  entries: Array<{ lang: 'en' | 'es'; voice?: string; phrase: string }>;
  log: (m: string) => void;
  renderTts?: typeof renderWyomingTts;
}): Promise<{ rendered: number; cached: number; failed: number }> {
  const render = opts.renderTts ?? renderWyomingTts;
  let rendered = 0, cached = 0, failed = 0;
  for (const e of opts.entries) {
    // Unpinned (empty) voice never persists — see the pinned-voice rule in
    // terminatorPcm. Nothing to pre-warm for it.
    if (e.phrase.length === 0 || (e.voice ?? '').length === 0) continue;
    const file = resolve(opts.cacheDir, `term-${terminatorKey(e.lang, e.voice, e.phrase)}.wav`);
    try { await access(file); cached++; continue; } catch { /* absent — render below */ }
    const spoken = e.lang === 'es' ? verbalizeForTtsEs(e.phrase) : verbalizeForTts(e.phrase);
    const r = await render({ host: opts.host, port: opts.port, text: spoken, voice: e.voice, timeoutMs: PREWARM_TIMEOUT_MS });
    if (!r.ok || !r.wav || !parseWavHeader(r.wav).ok) {
      failed++;
      opts.log(`audioRenderer: terminator pre-warm failed (lang=${e.lang} voice=${e.voice ?? 'default'}): ${r.error ?? 'malformed WAV'} — halting pre-warm (renders on demand instead)`);
      break; // never fire the next request at a server that just failed/stalled
    }
    residentVoice = e.voice ?? ''; // Piper genuinely holds this voice now
    await persistTerminatorWav(opts.cacheDir, file, r.wav);
    rendered++;
  }
  opts.log(`audioRenderer: terminator pre-warm — ${rendered} rendered, ${cached} already cached${failed > 0 ? `, ${failed} failed` : ''}`);
  return { rendered, cached, failed };
}


/** Bump when the render pipeline changes in a way that invalidates the cache.
 *  v2 (v0.12.1): the optional lead-in silence is now part of every render.
 *  v3 (v0.15.4): announce-repeat folded into the key.
 *  v4 (v0.15.7): inter-repeat silence gap folded into the key.
 *  v5 (v0.15.15): post-chime silence gap (chime → pause → spoken message).
 *  v6 (v0.23.0): one-time flush of every combined render after the tone-onset
 *      fix (softened named-tone attacks), so any stale/short cached clip from
 *      the v0.17.0 tone rebuild is re-rendered with the corrected tones. The
 *      audio-asset version is ALSO folded into named/custom keys below so a
 *      future asset regeneration auto-invalidates dependent combined renders. */
export const RENDER_VERSION = 6;

/** v0.15.4 — hard ceiling on the chime-repeat count at the allocation site.
 *  getChimeRepeat() is already clamped to ≤4 by alertSettings; this is a
 *  belt-and-suspenders bound (well above that max) so the Buffer arrays built
 *  from it can never allocate without limit, even if the upstream clamp changes.
 *  Applied identically in renderAnnouncement and renderCacheKey so the rendered
 *  audio and the predicted cache filename stay in lock-step. */
const MAX_CHIME_REPEAT = 8;

/** v0.61.0 — spoken terminator appended to the FINAL play of every announcement
 *  so the operator hears a clear close and isn't left waiting for more. Rendered
 *  as its own short Piper utterance and spliced after the last repeated block.
 *  Operator-overridable via BROADCAST_END_OF_MESSAGE_PHRASE (empty disables it);
 *  the gap separates it from the message tail. Exported so the broadcast config
 *  and tests reference the same defaults — keeping audio + cache key in lock-step. */
export const END_OF_MESSAGE_PHRASE = 'End of message';
export const END_OF_MESSAGE_GAP_MS = 700;

export type AnnouncementLevel = 'red' | 'yellow' | 'green';

export interface RenderOptions {
  level: AnnouncementLevel;
  /** TTS text. Empty/null → klaxon-only (still cached, no Wyoming call). */
  message: string | null;
  /** Directory containing the pre-generated klaxon WAVs (e.g. /data/audio). */
  klaxonDir: string;
  /** Directory to cache combined announcement WAVs in. */
  cacheDir: string;
  /** Wyoming server hostname (default 'core-piper' from inside add-on). */
  wyomingHost: string;
  /** Wyoming server port (default 10200). */
  wyomingPort: number;
  /** Optional Piper voice override (e.g. "en_US-amy-medium"). */
  wyomingVoice?: string;
  /**
   * v0.12.1 — milliseconds of digital silence to prepend before the first
   * chime, so multi-room/AirPlay speakers can establish their stream before
   * any audible audio (fixes the clipped start + slow AirPlay devices missing
   * the announcement). Part of the cache key. Default/undefined → 0 (no lead-in).
   */
  leadSilenceMs?: number;
  /**
   * v0.15.4 — number of times the whole (chime×N + spoken message) block repeats
   * in the single rendered WAV, so a missed first annunciation gets a second pass
   * within the same MA announcement. Clamped 1..3. Part of the cache key.
   * Default/undefined → 1 (no repeat).
   */
  announceRepeat?: number;
  /**
   * v0.15.7 — milliseconds of digital silence inserted BETWEEN the repeated
   * (chime + spoken message) blocks, so the listener can hear the message
   * conclude and start again rather than the two passes running together. Only
   * applies when announceRepeat > 1. Part of the cache key. Default/undefined → 0.
   */
  repeatGapMs?: number;
  /**
   * v0.15.15 — milliseconds of digital silence inserted AFTER the chime group,
   * before the spoken message, so the chime decays and the announcement starts
   * cleanly instead of riding the chime's tail. Applies inside every repeated
   * block. Part of the cache key. Default/undefined → 1000.
   */
  chimeGapMs?: number;
  /**
   * v0.15.23 — absolute path to the chime WAV to prepend, OVERRIDING the
   * built-in klaxon at klaxonDir/KLAXON_FOR_LEVEL[level]. The operator's Alert
   * Console assigns a custom tone per level (chimeConfig.resolveChime). The
   * file MUST be the renderer's format (22050/16/mono — chimeStore normalizes
   * every upload to it). When the custom file is unreadable, the renderer
   * FALLS BACK to the built-in klaxon for the level rather than failing the
   * whole announcement (never a silent alarm). Undefined → built-in klaxon.
   */
  chimePath?: string;
  /**
   * v0.15.23 — cache-key identity for the resolved chime. The render cache key
   * keys off `level`, not the chime file, so a tone swap would serve a STALE
   * render without this. Pass BUILTIN_CHIME_TAG for the klaxon (component
   * omitted → byte-identical to pre-feature keys) or the custom tone's content
   * id otherwise. MUST match what chimeConfig.resolveChime returns alongside
   * chimePath, so the rendered audio and the cache key stay in lock-step.
   */
  chimeTag?: string;
  /**
   * v0.61.0 — append a spoken "End of message" terminator to the FINAL play
   * (the last announceRepeat block) so the operator knows the announcement has
   * finished and isn't waiting for more. Rendered as its own short Piper
   * utterance and spliced after the last message block, with endOfMessageGapMs
   * of silence before it. A tail render failure (or format mismatch) is
   * NON-FATAL — the message still plays (a power-system alarm must never be
   * silenced by a cosmetic tail). Part of the cache key. Neutral default → off;
   * the broadcast config defaults it ON and passes it explicitly.
   */
  endOfMessage?: boolean;
  /** v0.61.0 — the terminator phrase. Blank disables it. Part of the key.
   *  Default → END_OF_MESSAGE_PHRASE ('End of message'). */
  endOfMessagePhrase?: string;
  /** v0.67.0 — Spanish terminator phrase for the Spanish pass of a bilingual render.
   *  Each language pass gets its OWN-language terminator (English pass → endOfMessagePhrase,
   *  Spanish pass → this). Blank → the Spanish pass falls back to endOfMessagePhrase. Part
   *  of the cache key. */
  endOfMessagePhraseEs?: string;
  /** v0.61.0 — silence (ms) before the terminator on the final block. Part of
   *  the key. Default → END_OF_MESSAGE_GAP_MS. */
  endOfMessageGapMs?: number;
  /**
   * v0.62.0 — bilingual / multi-language passes. When provided and non-empty,
   * this REPLACES the single-`message`×`announceRepeat` repeat: each entry is
   * rendered as its own pass (chime + that text, in that voice + language), in
   * order, and the announcement plays them once each — e.g. [English, Spanish].
   * The terminator rides the LAST surviving pass; its voice + language track that
   * pass. A pass whose TTS fails to render (e.g. a Spanish voice not installed) is
   * DROPPED — non-fatal, the other passes still play (never a silent alarm). Each
   * entry is verbalized with the normalizer for its `lang` (default 'en'). Part of
   * the cache key. When omitted, the legacy single-`message` path is unchanged.
   */
  messages?: ReadonlyArray<{ text: string; voice?: string; lang?: 'en' | 'es' }>;
  /** Logger; receives one line per stage. */
  log: (m: string) => void;
  /** v1.47.4 — injectable Wyoming renderer (tests). Defaults to renderWyomingTts. */
  renderTts?: typeof renderWyomingTts;
}

export interface RenderResult {
  ok: boolean;
  /** Basename of the rendered file in cacheDir (e.g. "a1b2c3.wav"). */
  filename?: string;
  /** Full size in bytes. */
  sizeBytes?: number;
  /** Source breakdown for diagnostics. */
  fromCache?: boolean;
  ttsRenderMs?: number;
  /** Reason if ok=false. */
  error?: string;
}

interface WavHeader {
  ok: boolean;
  rate: number;
  width: number;       // bytes per sample (1, 2, or 4)
  channels: number;
  dataOffset: number;
  dataLength: number;
}

export const KLAXON_FOR_LEVEL: Record<AnnouncementLevel, string> = {
  red: 'red-alert.wav',
  yellow: 'yellow-alert.wav',
  green: 'all-clear.wav',
};

/** v0.15.23 — cache-key tag for the built-in klaxon. A single fixed literal so
 *  builtin cache keys are BYTE-IDENTICAL to the pre-feature key string (the tag
 *  component is omitted entirely for this value — see renderCacheKey), giving
 *  zero cache churn for operators who never assign a custom tone. Kept in sync
 *  with chimeConfig.BUILTIN_TAG (duplicated here to avoid an import cycle). */
export const BUILTIN_CHIME_TAG = 'builtin';

/**
 * v0.12.1 — a frame-aligned, zero-filled PCM buffer of `leadMs` milliseconds of
 * silence at the given WAV format. Zeros are mid-scale (true silence) for signed
 * PCM, so no DSP is needed. Frame size = channels × bytes-per-sample, so the
 * length is rounded to a whole number of frames — otherwise the downstream
 * byte-splice would misalign every following sample. Returns an empty buffer for
 * leadMs ≤ 0 or a degenerate format.
 */
function makeSilencePcm(header: WavHeader, leadMs: number): Buffer {
  if (leadMs <= 0 || header.rate <= 0 || header.width <= 0 || header.channels <= 0) {
    return Buffer.alloc(0);
  }
  const frames = Math.round((header.rate * leadMs) / 1000);
  return Buffer.alloc(frames * header.channels * header.width);
}

/**
 * v0.61.0 / v0.62.0 — assemble the PCM part list for an announcement: lead-in
 * silence, then each per-pass `block` in order (with `gap` between passes), and
 * a per-pass terminator `tails[i]` (preceded by `endGap`) spliced after its block. The
 * caller supplies a terminator only on the LAST block of each language, so a bilingual
 * alarm gets "End of message" after the English pass AND "Fin del mensaje" after the
 * Spanish pass, while a monolingual alarm (the legacy "say it twice" repeat of one
 * block) gets ONE terminator on the final block only. Pure + exported so the per-pass
 * placement is unit-testable without a live Wyoming render.
 */
export function assembleAnnouncementParts(
  silence: Buffer,
  blocks: ReadonlyArray<Buffer[]>,
  gap: Buffer,
  tails: ReadonlyArray<Buffer | null>,
  endGap: Buffer,
): Buffer[] {
  const parts: Buffer[] = [silence];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0 && gap.length > 0) parts.push(gap);
    parts.push(...blocks[i]);
    const tail = tails[i];
    if (tail) {
      if (endGap.length > 0) parts.push(endGap);
      parts.push(tail);
    }
  }
  return parts;
}

/**
 * Render (or fetch from cache) the combined announcement WAV. Returns
 * the basename to serve via the panel's HTTP static route.
 */
export async function renderAnnouncement(opts: RenderOptions): Promise<RenderResult> {
  const { level, message, klaxonDir, cacheDir, wyomingHost, wyomingPort, wyomingVoice, log } = opts;
  const doRender = opts.renderTts ?? renderWyomingTts; // v1.47.4 — injectable for tests

  // v0.11.0 — chime repeats getChimeRepeat() times (default 2) before the TTS.
  // Resolve N once here so it's part of both the rendered audio AND the cache
  // key — changing the repeat count must invalidate any previously cached file.
  // v0.15.4 — re-assert a hard upper bound at the point of use. getChimeRepeat()
  // is already clamped to ≤4 by clampChime(), but bounding locally guarantees the
  // Array(chimeRepeat[*announceRepeat]) allocations below can never grow unbounded
  // even if that distant clamp regresses — defense-in-depth on the alert path.
  // The cap is well above the settings max, so it never changes real behaviour or
  // the cache key. NOTE: this is written as an explicit comparison GUARD rather
  // than Math.min() on purpose — CodeQL's js/resource-exhaustion taint tracker
  // recognises a relational upper-bound check as a sanitizer, but not Math.min(),
  // and the guard must be inline here (an interprocedural helper isn't trusted at
  // the allocation sink).
  let chimeRepeat = Math.max(1, Math.round(getChimeRepeat()));
  if (chimeRepeat > MAX_CHIME_REPEAT) chimeRepeat = MAX_CHIME_REPEAT;
  // v0.15.4 — repeat the whole (chime + spoken message) block N times so a missed
  // first annunciation gets a second pass. Clamped 1..3; part of the cache key.
  const announceRepeat = Math.max(1, Math.min(3, Math.round(opts.announceRepeat ?? 1)));

  // v0.12.1 — lead-in silence (ms) prepended before the first chime. Resolved
  // once so it's part of both the rendered audio AND the cache key.
  const leadMs = Math.max(0, Math.round(opts.leadSilenceMs ?? 0));
  // v0.15.7 — silence (ms) inserted between repeated blocks so the repeat is
  // audibly distinct. Only meaningful when announceRepeat > 1. Part of the key.
  const repeatGapMs = Math.max(0, Math.round(opts.repeatGapMs ?? 0));
  // v0.15.15 — silence (ms) after the chime group, before the spoken message.
  const chimeGapMs = Math.max(0, Math.round(opts.chimeGapMs ?? 1000));

  // v0.61.0 — "End of message" terminator on the FINAL play. Resolved once here
  // (neutral default OFF — the broadcast config defaults it ON) so the SAME
  // values feed both the rendered audio AND the cache key. The effective enable
  // (toggle AND non-blank phrase) is recomputed identically inside renderCacheKey,
  // so a tail-bearing render and its predicted filename stay in lock-step.
  const endOfMessage = opts.endOfMessage ?? false;
  const endOfMessagePhrase = (opts.endOfMessagePhrase ?? END_OF_MESSAGE_PHRASE).trim();
  const endOfMessageGapMs = Math.max(0, Math.round(opts.endOfMessageGapMs ?? END_OF_MESSAGE_GAP_MS));
  // v0.67.0 — Spanish terminator phrase (blank → the Spanish pass falls back to the
  // English phrase). Drives the per-language terminator on the Spanish pass.
  const endOfMessagePhraseEs = (opts.endOfMessagePhraseEs ?? '').trim();
  const tailEnabled = endOfMessage && endOfMessagePhrase.length > 0;

  // Cache key derivation: stable for the same (version, level, message, repeat,
  // lead silence). Null message hashes distinctly from empty string so klaxon-
  // only and empty-spoken-message don't share a cache slot. The repeat count
  // and lead-in are part of the key so changing either busts the cache.
  // v0.15.4 — single source of truth for the cache key (shared with the exported
  // renderCacheKey, which callers use to predict the served filename).
  // v0.15.23 — resolve the chime (custom tone or built-in klaxon) + its cache
  // tag. The tag is folded into the key so swapping a tone busts the cache; the
  // built-in tag is OMITTED from the key so default users see zero cache churn.
  const chimeTag = opts.chimeTag ?? BUILTIN_CHIME_TAG;
  const hash = renderCacheKey(level, message, chimeRepeat, leadMs, announceRepeat, repeatGapMs, chimeGapMs, chimeTag, endOfMessage, endOfMessagePhrase, endOfMessageGapMs, opts.messages, wyomingVoice, endOfMessagePhraseEs);
  const filename = `${hash}.wav`;
  const outPath = resolve(cacheDir, filename);

  // Cache hit short-circuit. v0.20.0 — a single async stat (which yields both
  // existence and size) replaces the prior synchronous existsSync + stat; ENOENT
  // throws into the catch, so the fall-through-to-render behavior is unchanged
  // and the event loop is no longer blocked on the common cache-hit path.
  try {
    const st = await stat(outPath);
    return { ok: true, filename, sizeBytes: st.size, fromCache: true };
  } catch {
    // not cached (or unstattable) → fall through to re-render
  }

  // Load the chime. v0.15.23 — a custom tone (opts.chimePath) overrides the
  // built-in klaxon, but a read failure FALLS BACK to the built-in for the
  // level rather than failing the announcement — a missing/corrupt tone must
  // never silence an alarm on a live power system.
  const builtinPath = resolve(klaxonDir, KLAXON_FOR_LEVEL[level]);
  const klaxonPath = opts.chimePath ?? builtinPath;
  let klaxonWav: Buffer;
  try {
    klaxonWav = await readFile(klaxonPath);
  } catch (e: any) {
    if (opts.chimePath && klaxonPath !== builtinPath) {
      log(`audioRenderer: custom chime unreadable (${e?.message ?? e}) — falling back to built-in klaxon`);
      try {
        klaxonWav = await readFile(builtinPath);
      } catch (e2: any) {
        return { ok: false, error: `klaxon read failed (builtin fallback): ${e2?.message ?? e2}` };
      }
    } else {
      return { ok: false, error: `klaxon read failed: ${e?.message ?? e}` };
    }
  }
  const klaxonHeader = parseWavHeader(klaxonWav);
  if (!klaxonHeader.ok) {
    return { ok: false, error: `klaxon WAV malformed: ${klaxonPath}` };
  }

  // No TTS → klaxon-only path. Cache the klaxon under the hash so the HTTP
  // serving path is uniform. v0.11.0 — repeat the chime N times so a chime-
  // only announcement matches the repeat applied on the chime+TTS path. When
  // N == 1 this is byte-identical to the original klaxon WAV.
  // v0.62.0 — klaxon-only only when NEITHER the legacy message NOR any bilingual
  // pass has spoken text.
  const anySpoken = (message != null && message.trim().length > 0)
    || (opts.messages?.some((m) => m.text.trim().length > 0) ?? false);
  if (!anySpoken) {
    // TOCTOU/atomicity hardening (CodeQL js/file-system-race): the stat()
    // cache-miss above must not pair with a direct write to the final path —
    // write an unpredictable same-directory temp, then rename, so the HTTP
    // path can never serve a partially-written WAV either.
    const tmpPath = `${outPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(cacheDir, { recursive: true });
      // v0.12.1 — prepend the lead-in silence and repeat the chime. When
      // leadMs == 0 && chimeRepeat == 1 this is byte-identical to the klaxon WAV.
      const silence = makeSilencePcm(klaxonHeader, leadMs);
      let klaxonOnly = klaxonWav;
      if (silence.length > 0 || chimeRepeat > 1 || announceRepeat > 1) {
        const klaxonPcm = klaxonWav.subarray(klaxonHeader.dataOffset, klaxonHeader.dataOffset + klaxonHeader.dataLength);
        // v0.15.7 — emit announceRepeat blocks of chimeRepeat chimes, with a
        // silence gap between blocks so a repeat is audibly separated. Bounded
        // push-loops (chimeRepeat ≤ MAX_CHIME_REPEAT, announceRepeat ≤ 3) keep
        // this off the resource-exhaustion path.
        const gap = makeSilencePcm(klaxonHeader, repeatGapMs);
        const chimeParts: Buffer[] = [silence];
        for (let r = 0; r < announceRepeat; r++) {
          if (r > 0 && gap.length > 0) chimeParts.push(gap);
          for (let c = 0; c < chimeRepeat; c++) chimeParts.push(klaxonPcm);
        }
        const pcm = Buffer.concat(chimeParts);
        klaxonOnly = pcmToWav(pcm, klaxonHeader.rate, klaxonHeader.width, klaxonHeader.channels);
      }
      await writeFile(tmpPath, klaxonOnly, { flag: 'wx' });
      await rename(tmpPath, outPath);
      return { ok: true, filename, sizeBytes: klaxonOnly.length, fromCache: false };
    } catch (e: any) {
      await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
      return { ok: false, error: `cache write failed: ${e?.message ?? e}` };
    }
  }

  // v0.62.0 — resolve the spoken PASSES. By default a single pass (the legacy
  // `message`) repeated `announceRepeat` times for missed-first-pass reliability.
  // When `opts.messages` is given, each entry is its OWN pass (e.g. English then
  // Spanish), played once each in order; announceRepeat no longer multiplies (the
  // list defines the sequence). Each pass is verbalized with its language's
  // normalizer at the v0.57.0 chokepoint — English expands units/symbols; Spanish
  // ("es") leaves the already-clean wording and normalizes only stray symbols.
  const multi = !!(opts.messages && opts.messages.length > 0);
  const passSpecs: Array<{ text: string; voice?: string; lang: 'en' | 'es' }> = multi
    ? opts.messages!.map((m) => ({ text: m.text, voice: m.voice ?? wyomingVoice, lang: m.lang ?? 'en' }))
    : [{ text: message ?? '', voice: wyomingVoice, lang: 'en' }];

  // Render each UNIQUE (lang, voice, text) once — the legacy path repeats one
  // pass, so this de-dupes its single render. A pass whose TTS fails OR whose WAV
  // format doesn't match the klaxon is DROPPED (non-fatal); the others still play.
  const passKey = (s: { lang: 'en' | 'es'; voice?: string; text: string }) =>
    `${s.lang}\u0000${s.voice ?? ''}\u0000${s.text}`;
  const renderedPcm = new Map<string, Buffer>();
  const failedKeys = new Set<string>();
  let firstTtsMs: number | undefined;
  let lastFailReason: string | undefined;
  // v1.47.5 — ONE budget for the whole spoken phase (passes + terminators), so
  // a starved/wedged Piper can delay the alarm by at most this much before the
  // caller's chime-only fallback takes over.
  const spokenDeadline = Date.now() + SPOKEN_BUDGET_MS;
  // v1.47.4 — render the resident voice first (playback order is unaffected —
  // it is driven by survivingSpecs/passSpecs below, so English still plays first).
  for (const spec of residentFirst(passSpecs)) {
    const k = passKey(spec);
    if (renderedPcm.has(k) || failedKeys.has(k)) continue;
    const spokenText = spec.lang === 'es' ? verbalizeForTtsEs(spec.text) : verbalizeForTts(spec.text);
    const r = await renderWithinBudget(doRender, wyomingHost, wyomingPort, spokenText, spec.voice, spokenDeadline, log, `spoken pass (lang=${spec.lang} voice=${spec.voice ?? 'default'})`);
    if (r == null) { failedKeys.add(k); lastFailReason ??= 'spoken-render budget spent'; continue; }
    if (!r.ok || !r.wav) {
      failedKeys.add(k);
      lastFailReason = r.error ?? 'wyoming render failed';
      log(`audioRenderer: spoken pass render failed (lang=${spec.lang} voice=${spec.voice ?? 'default'}): ${lastFailReason}${multi ? ' — dropping that pass' : ''}`);
      continue;
    }
    residentVoice = spec.voice ?? ''; // Piper now holds this voice
    const h = parseWavHeader(r.wav);
    if (!h.ok || h.rate !== klaxonHeader.rate || h.width !== klaxonHeader.width || h.channels !== klaxonHeader.channels) {
      failedKeys.add(k);
      lastFailReason = h.ok
        ? `format mismatch — klaxon=${klaxonHeader.rate}/${klaxonHeader.width * 8}/${klaxonHeader.channels} tts=${h.rate}/${h.width * 8}/${h.channels}`
        : 'TTS WAV malformed (header parse failed)';
      log(`audioRenderer: spoken pass ${lastFailReason} (lang=${spec.lang}, voice=${spec.voice ?? 'default'})${multi ? ' — dropping that pass' : ''}`);
      continue;
    }
    firstTtsMs ??= r.durationMs;
    renderedPcm.set(k, r.wav.subarray(h.dataOffset, h.dataOffset + h.dataLength));
  }

  // Surviving passes, in original order. ≥1 must survive (English always renders
  // in practice; a total failure is a hard error, matching the prior behavior).
  // The error carries the last failure reason so a single-pass format mismatch
  // (e.g. a 16 kHz Piper voice) is still diagnosable.
  const survivingSpecs = passSpecs.filter((s) => renderedPcm.has(passKey(s)));
  if (survivingSpecs.length === 0) {
    noteTtsRenderFailure(lastFailReason ?? 'wyoming render failed (no spoken pass rendered)');
    return { ok: false, error: lastFailReason ?? 'wyoming render failed (no spoken pass rendered)', ttsRenderMs: firstTtsMs };
  }
  const droppedPass = survivingSpecs.length < passSpecs.length;
  log(`audioRenderer: rendered ${renderedPcm.size} spoken pass(es)${droppedPass ? ` (${passSpecs.length - survivingSpecs.length} dropped)` : ''} in ${firstTtsMs ?? 0}ms (first)`);

  // Build one block (chime×chimeRepeat + post-chime gap + spoken pass) PER PASS.
  // Legacy: the single surviving pass repeated announceRepeat times (reuses the
  // same PCM buffers). Multi: each surviving pass once, in order. The chime list
  // is a bounded push-loop (chimeRepeat ≤ MAX_CHIME_REPEAT) to stay off the
  // resource-exhaustion path; for the monolingual case this is byte-identical to
  // the prior single-block form.
  const klaxonPcm = klaxonWav.subarray(klaxonHeader.dataOffset, klaxonHeader.dataOffset + klaxonHeader.dataLength);
  const silence = makeSilencePcm(klaxonHeader, leadMs);
  const chimeGap = makeSilencePcm(klaxonHeader, chimeGapMs);
  const buildBlock = (ttsPcm: Buffer): Buffer[] => {
    const b: Buffer[] = [];
    for (let i = 0; i < chimeRepeat; i++) b.push(klaxonPcm);
    if (chimeGap.length > 0) b.push(chimeGap);
    b.push(ttsPcm);
    return b;
  };
  const playSpecs = multi
    ? survivingSpecs
    : Array.from({ length: announceRepeat }, () => survivingSpecs[0]);
  const blocks: Buffer[][] = playSpecs.map((s) => buildBlock(renderedPcm.get(passKey(s))!));

  // v0.61.0 / v0.62.0 / v0.67.0 — per-language "End of message" terminator. A terminator
  // rides the LAST block of each language: a bilingual alarm says the English phrase after
  // the English pass AND the Spanish phrase after the Spanish pass; a mono alarm
  // (announceRepeat copies of ONE pass) gets a single terminator on the final block only
  // (no later block shares its language). Each is voiced + verbalized in its own language.
  // NON-FATAL: a terminator that fails to render / mismatches format is omitted (the
  // message still plays) and marks the render incomplete so it isn't cached terminator-less
  // under the terminator-on key.
  const tails: Array<Buffer | null> = new Array(playSpecs.length).fill(null);
  let tailDropped = false;
  if (tailEnabled) {
    const tailPcmByKey = new Map<string, Buffer | null>(); // dedup identical (lang, voice, phrase)
    // v1.47.4 — collect the per-language terminator jobs first, then render them
    // resident-voice-first (with retry), so the terminator of the voice Piper
    // still holds needs no reload. Output is unchanged — tails[i] is filled the
    // same way; only the render-call order is optimized.
    type TailJob = { i: number; lang: 'en' | 'es'; voice?: string; phrase: string; ck: string };
    const jobs: TailJob[] = [];
    for (let i = 0; i < playSpecs.length; i++) {
      const spec = playSpecs[i];
      // Only the LAST block of each language carries that language's terminator.
      const lastOfLang = !playSpecs.slice(i + 1).some((s) => s.lang === spec.lang);
      if (!lastOfLang) continue;
      const phrase = spec.lang === 'es' ? (endOfMessagePhraseEs || endOfMessagePhrase) : endOfMessagePhrase;
      if (phrase.length === 0) continue;
      jobs.push({ i, lang: spec.lang, voice: spec.voice, phrase, ck: `${spec.lang} ${spec.voice ?? ''} ${phrase}` });
    }
    for (const job of residentFirst(jobs)) {
      if (tailPcmByKey.has(job.ck)) continue;
      const tailSpoken = job.lang === 'es' ? verbalizeForTtsEs(job.phrase) : verbalizeForTts(job.phrase);
      // v1.47.6 — served from the persistent terminator cache; only the very
      // first announcement per (lang, voice, phrase) pays a render.
      const t = await terminatorPcm({
        cacheDir, host: wyomingHost, port: wyomingPort, phrase: job.phrase, spoken: tailSpoken,
        voice: job.voice, lang: job.lang,
        fmt: { rate: klaxonHeader.rate, width: klaxonHeader.width, channels: klaxonHeader.channels },
        render: doRender, deadline: spokenDeadline, log,
      });
      if (t.dropped) tailDropped = true;
      tailPcmByKey.set(job.ck, t.pcm);
    }
    for (const job of jobs) tails[job.i] = tailPcmByKey.get(job.ck) ?? null;
  }

  const gap = makeSilencePcm(klaxonHeader, repeatGapMs);
  const anyTail = tails.some((t) => t != null);
  const endGap = anyTail ? makeSilencePcm(klaxonHeader, endOfMessageGapMs) : Buffer.alloc(0);
  const parts = assembleAnnouncementParts(silence, blocks, gap, tails, endGap);
  const combinedPcm = Buffer.concat(parts);
  const combined = pcmToWav(combinedPcm, klaxonHeader.rate, klaxonHeader.width, klaxonHeader.channels);

  // v0.62.0 — only a COMPLETE render (no intended pass dropped, and any intended
  // terminator present) is written under the cache-key filename. An INCOMPLETE
  // render (e.g. the Spanish voice isn't installed yet) is written to a distinct
  // `.partial.wav` name: it's served for THIS announcement but never cache-hit, so
  // once the voice is provisioned the next render is complete and caches properly
  // — no stale English-only file lingers under the bilingual key on persistent
  // /data. Both are pruned by age (pruneRenderCache matches `*.wav`). Atomic
  // tmp → rename so a half-written file never serves.
  const incomplete = droppedPass || tailDropped;
  const servedName = incomplete ? `${hash}.partial.wav` : filename;
  const servedPath = resolve(cacheDir, servedName);
  // Same unpredictable-temp + exclusive-create hardening as the klaxon-only
  // cache write above (a guessable `<path>.tmp` could be pre-planted).
  const tmpPath = `${servedPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(tmpPath, combined, { flag: 'wx' });
    await rename(tmpPath, servedPath);
  } catch (e: any) {
    await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
    return { ok: false, error: `cache write failed: ${e?.message ?? e}` };
  }

  noteTtsRenderSuccess();
  return {
    ok: true,
    filename: servedName,
    sizeBytes: combined.length,
    fromCache: false,
    ttsRenderMs: firstTtsMs,
  };
}

/**
 * Parse a 44-byte RIFF/WAVE header. Returns format params + the offset
 * + length of the 'data' chunk for byte-splice operations.
 *
 * Tolerates extra chunks between 'fmt ' and 'data' (Piper sometimes
 * emits a LIST chunk for metadata) by scanning for the 'data' marker.
 */
export function parseWavHeader(wav: Buffer): WavHeader {
  if (wav.length < 44) return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
  if (wav.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };

  // Locate 'fmt ' chunk (typically at offset 12)
  let cursor = 12;
  let rate = 0;
  let width = 0;
  let channels = 0;
  let fmtFound = false;
  while (cursor + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', cursor, cursor + 4);
    const chunkSize = wav.readUInt32LE(cursor + 4);
    const chunkBody = cursor + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = wav.readUInt16LE(chunkBody + 2);
      rate = wav.readUInt32LE(chunkBody + 4);
      const bitsPerSample = wav.readUInt16LE(chunkBody + 14);
      width = bitsPerSample / 8;
      fmtFound = true;
    } else if (chunkId === 'data') {
      if (!fmtFound) return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
      return { ok: true, rate, width, channels, dataOffset: chunkBody, dataLength: chunkSize };
    }
    // Chunk sizes are word-aligned in the spec (round up to even).
    cursor = chunkBody + chunkSize + (chunkSize % 2);
  }
  return { ok: false, rate: 0, width: 0, channels: 0, dataOffset: 0, dataLength: 0 };
}

/**
 * Optional cleanup helper — prunes cached announcement files older than
 * `maxAgeMs`. Called periodically by the broadcast monitor so the cache
 * doesn't grow unboundedly on installs with many unique alerts.
 */
export async function pruneRenderCache(cacheDir: string, maxAgeMs: number, log: (m: string) => void): Promise<number> {
  if (!existsSync(cacheDir)) return 0;
  const now = Date.now();
  let removed = 0;
  try {
    for (const name of await readdir(cacheDir)) {
      // v0.79.0 — also sweep crash-orphaned atomic-write temps. The unique
      // random temp names (`*.tmp`, hardened for CodeQL) mean a power cut
      // between write and rename leaves an orphan nothing overwrites (the old
      // fixed `.tmp` name self-healed by the next render); reclaim any .tmp
      // older than 1 h — far beyond any live render, which completes in
      // seconds — so /data can't slowly fill with unreclaimable orphans.
      const isTmp = name.endsWith('.tmp');
      if (!name.endsWith('.wav') && !isTmp) continue;
      // v1.48.0 — terminator cache files are PERMANENT by design (the phrases
      // never change and each avoided re-render is a whole voice switch on the
      // alarm path). Age-pruning them silently re-introduced cold terminator
      // renders for exactly the long-uptime / rare-alarm installs. Orphaned
      // term-*.tmp files are still swept by the 1 h rule below.
      if (name.startsWith('term-') && !isTmp) continue;
      const full = resolve(cacheDir, name);
      try {
        const st = await stat(full);
        const ageLimit = isTmp ? Math.min(maxAgeMs, 3_600_000) : maxAgeMs;
        if (now - st.mtimeMs > ageLimit) {
          await unlink(full);
          removed++;
        }
      } catch { /* race with another writer — skip */ }
    }
  } catch (e: any) {
    log(`audioRenderer: prune failed: ${e?.message ?? e}`);
  }
  if (removed > 0) log(`audioRenderer: pruned ${removed} stale cache file(s)`);
  return removed;
}

/**
 * Hash function exposed for tests so the cache-key format is pinned.
 * v0.11.0 — the chime-repeat count is part of the key (changing it busts the
 * cache). Defaults to the live getChimeRepeat() so callers/tests that don't
 * pass it match what renderAnnouncement() would produce.
 */
export function renderCacheKey(
  level: AnnouncementLevel,
  message: string | null,
  chimeRepeat?: number,
  leadSilenceMs?: number,
  announceRepeat?: number,
  repeatGapMs?: number,
  chimeGapMs?: number,
  chimeTag?: string,
  endOfMessage?: boolean,
  endOfMessagePhrase?: string,
  endOfMessageGapMs?: number,
  messages?: ReadonlyArray<{ text: string; voice?: string; lang?: 'en' | 'es' }>,
  // v0.64.0 — the globally-configured Wyoming voice (BROADCAST_WYOMING_VOICE). Folded
  // into the key so a voice change re-renders: the monolingual path keys on it directly,
  // and the bilingual path resolves each inherited-voice pass to it (matching the audio
  // renderAnnouncement actually produces via `m.voice ?? wyomingVoice`).
  wyomingVoice?: string,
  // v0.67.0 — Spanish terminator phrase; folded into the terminator identity so a
  // bilingual render whose two passes carry different-language terminators keys distinctly.
  endOfMessagePhraseEs?: string,
): string {
  // v0.15.4 — same bound as renderAnnouncement so the predicted filename and the
  // rendered audio agree, and so a caller-supplied chimeRepeat can't grow the key
  // space without limit.
  const repeat = Math.max(1, Math.min(MAX_CHIME_REPEAT, Math.round(chimeRepeat ?? getChimeRepeat())));
  // v0.15.4 — announce-repeat (whole chime+message block) is part of the key.
  const annRepeat = Math.max(1, Math.min(3, Math.round(announceRepeat ?? 1)));
  const leadMs = Math.max(0, Math.round(leadSilenceMs ?? 0));
  // v0.15.7 — inter-repeat silence gap is part of the key.
  const gapMs = Math.max(0, Math.round(repeatGapMs ?? 0));
  // v0.15.15 — post-chime silence gap is part of the key.
  const cgMs = Math.max(0, Math.round(chimeGapMs ?? 1000));
  // v0.15.23 — custom-chime identity. The component is OMITTED for the built-in
  // klaxon (BUILTIN_CHIME_TAG) so default users' keys are byte-identical to the
  // pre-feature string (zero cache churn); a custom tone's content id makes the
  // key distinct so swapping a tone re-renders. Applied identically here and at
  // the renderAnnouncement call site (both pass opts.chimeTag ?? BUILTIN_CHIME_TAG).
  const tag = chimeTag ?? BUILTIN_CHIME_TAG;
  // v0.23.0 — for a named/custom tone, also key on AUDIO_ASSETS_VERSION so a
  // future tone-asset regeneration (a builder/envelope change) invalidates the
  // dependent combined render instead of silently serving a stale/clipped clip.
  // The builtin klaxon still OMITS the component (zero cache churn for the
  // default; the RENDER_VERSION bump above already flushes it once).
  const tagPart = tag === BUILTIN_CHIME_TAG ? '' : `|k${tag}|a${AUDIO_ASSETS_VERSION}`;
  // v0.61.0 — "End of message" terminator identity. OMITTED when disabled (or the
  // phrase is blank) so a tail-off render is BYTE-IDENTICAL to the pre-feature key
  // (zero churn for that case); when enabled, the phrase + pre-terminator gap are
  // folded in so toggling it (or changing the phrase/gap) re-renders. The SAME
  // effective-enable rule runs in renderAnnouncement so audio + key stay in lock-step.
  const eomPhrase = (endOfMessagePhrase ?? END_OF_MESSAGE_PHRASE).trim();
  const eomOn = (endOfMessage ?? false) && eomPhrase.length > 0;
  const eomGapMs = Math.max(0, Math.round(endOfMessageGapMs ?? END_OF_MESSAGE_GAP_MS));
  // v0.67.0 — fold the Spanish terminator phrase too, so a bilingual render whose English
  // and Spanish passes carry DIFFERENT-language terminators keys distinctly. OMITTED when
  // blank → byte-identical to the pre-v0.67.0 (mono / Spanish-only-terminator) key.
  const eomPhraseEs = (endOfMessagePhraseEs ?? '').trim();
  const eomPart = eomOn ? `|e${eomGapMs}:${eomPhrase}${eomPhraseEs ? '~' + eomPhraseEs : ''}` : '';
  // v0.62.0 — bilingual / multi-pass identity. OMITTED when no messages (so the
  // monolingual key is byte-identical to pre-feature); when present, each pass's
  // (index, lang, voice, text) is folded in so the bilingual render gets a distinct
  // key and changing a language/voice/text re-renders. The terminator voice +
  // language derive from the final pass, so they're covered by this too.
  const msgPart = (messages && messages.length)
    ? '|L' + messages.map((m, i) => `${i}~${m.lang ?? 'en'}~${m.voice ?? wyomingVoice ?? ''}~${m.text}`).join('')
    : '';
  // v0.64.0 — monolingual (single-pass) resolved-voice identity. The bilingual path
  // already folds each pass's resolved voice into msgPart; the legacy single-pass path
  // had NO voice token at all, so a BROADCAST_WYOMING_VOICE change cache-hit the old
  // default voice's WAV. OMITTED when no voice is pinned (Piper server default) so
  // default users' keys stay byte-identical to the pre-feature string (zero churn);
  // a pinned voice makes the key distinct so swapping it re-renders.
  const voicePart = (!msgPart && wyomingVoice) ? `|V${wyomingVoice}` : '';
  return createHash('sha1')
    .update(`v${RENDER_VERSION}|${level}|x${repeat}|r${annRepeat}|s${leadMs}|g${gapMs}|c${cgMs}${tagPart}${eomPart}${msgPart}${voicePart}|${message ?? '<null>'}`)
    .digest('hex')
    .slice(0, 16);
}

/** Resolve a cached file path. Returns null if the file doesn't exist. */
export function cachedRenderPath(cacheDir: string, filename: string): string | null {
  const base = basename(filename);
  if (!/^[a-f0-9]{16}\.wav$/.test(base)) return null; // strict format
  const path = resolve(cacheDir, base);
  return existsSync(path) ? path : null;
}
