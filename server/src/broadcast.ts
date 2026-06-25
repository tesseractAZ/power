/**
 * v0.9.70 — Ship-wide audible broadcast (rewritten).
 *
 * Listens for alert-condition transitions and pushes a combined
 * klaxon + spoken-announcement WAV to every configured speaker through
 * Music Assistant's `play_announcement` service.
 *
 *     alert transition
 *          │
 *          ▼
 *     ┌──────────────────────────────────────────────────────────────┐
 *     │ audioRenderer.renderAnnouncement(level, message)              │
 *     │   1. Render TTS via Wyoming direct (core-piper:10200) → WAV   │
 *     │   2. Concat klaxon WAV ∥ TTS WAV → combined WAV               │
 *     │   3. Cache at /data/audio-render/<sha1>.wav                   │
 *     │   4. Return basename for HTTP serving                         │
 *     └──────────────────────────────────────────────────────────────┘
 *          │
 *          ▼
 *     ┌──────────────────────────────────────────────────────────────┐
 *     │ ONE music_assistant.play_announcement call                    │
 *     │   entity_id: [<every target>]                                 │
 *     │   url: http://panel:8787/audio-render/<sha1>.wav              │
 *     │   announce_volume: <BROADCAST_VOLUME * 100>                   │
 *     │   use_pre_announce: false                                     │
 *     └──────────────────────────────────────────────────────────────┘
 *          │
 *          ▼
 *     MA plays simultaneously across all targets, handles its own
 *     volume restore + queue management. No settle timers, no
 *     two-phase sequencing, no speaker-protocol staggering.
 *
 * Configuration (env vars, set in the add-on Configuration tab):
 *
 *   BROADCAST_ENABLED       true / false (default false — opt-in)
 *   BROADCAST_TARGETS       comma-separated media_player entity IDs
 *   BROADCAST_AUDIO_BASE    URL prefix the speakers fetch from.
 *                           Default "http://homeassistant.local:8787".
 *   BROADCAST_VOLUME        0..1 (default 0.5).
 *   BROADCAST_MIN_SEVERITY  "critical" | "warning" (default critical).
 *   BROADCAST_QUIET_HOURS   "22-06" (or empty). Non-critical alarms
 *                           are suppressed during this window.
 *   BROADCAST_WYOMING_HOST  Wyoming server hostname (default 'core-piper').
 *   BROADCAST_WYOMING_PORT  Wyoming server port (default 10200).
 *   BROADCAST_WYOMING_VOICE Piper voice override (default = Piper add-on default).
 *
 * Removed in v0.9.70:
 *
 *   - speakerProfiles.ts (protocol bucketing + bufferMs/fireAtMs staggering)
 *   - BROADCAST_USE_MUSIC_ASSISTANT (MA-only now)
 *   - BROADCAST_SONOS_RESTORE (MA's play_announcement handles this)
 *   - BROADCAST_TTS_SERVICE / BROADCAST_TTS_LANGUAGE / BROADCAST_TTS_REQUIRE_LOCAL
 *     (Wyoming is the only TTS path, always local, always off-grid safe)
 *   - BROADCAST_HA_EXTERNAL_URL (tts_proxy is no longer in the path)
 *   - Two-phase klaxon-then-TTS sequencing
 *   - All `await sleep(klaxonSettleMs)` / 5–8 sec settle windows
 *
 * Broadcast policy preserved from v0.9.18-v0.9.69:
 *
 *   - Fires on CONDITION TRANSITIONS, not per-tick.
 *   - First-render is silent (joining an already-RED state at boot is OK).
 *   - Min severity gates the broadcast.
 *   - Quiet hours suppress warning/info; critical always fires.
 *   - Test endpoint bypasses gates except the cooldown.
 *   - In-flight guard: tickInFlight blocks a second concurrent broadcast.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SnapshotStore } from './snapshot.js';
import type { Alert } from './alerts.js';
import { config } from './config.js';
import { callHaService, isSupervised, probeService, getEntityState } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';
import { renderAnnouncement, pruneRenderCache, END_OF_MESSAGE_PHRASE, END_OF_MESSAGE_GAP_MS, type AnnouncementLevel } from './audioRenderer.js';
import { resolveChime } from './chimeConfig.js';
import { buildAlertMessage, buildAlertMessageEs, priorityAnnouncementPrefixEs } from './ttsService.js';
import { getBroadcastRuntimeConfig, onBroadcastRuntimeConfigChange } from './broadcastRuntimeConfig.js';
// v0.11.0 — ISA-18.2 / IEC 62682 annunciation gate + per-priority preview.
// A priority turned off on the Alert Settings page must never trigger the
// chime/broadcast, so we filter silenced-priority alerts out before deriving
// the broadcast condition. previewMessageFor() drives the per-priority
// "preview announcement" feature on the settings page.
import {
  type AlarmPriority,
  priorityOf,
  klaxonLevelForPriority,
  previewMessageFor,
  priorityAnnouncementPrefix,
} from './alertPriority.js';
import { isPriorityEnabled } from './alertSettings.js';

/* ─── config ──────────────────────────────────────────────────────── */

export interface BroadcastConfig {
  enabled: boolean;
  targets: string[];
  audioBase: string;
  volume: number;
  minSeverity: 'critical' | 'warning';
  quietHours: [number, number] | null;
  /** v0.23.0 — when true, critical broadcasts (red condition / high+critical
   *  audible tiers) break through quiet hours; default false ⇒ quiet hours
   *  silence EVERY tier overnight. */
  criticalBreakThrough: boolean;
  /** v0.9.70 — Wyoming server location for TTS rendering. */
  wyomingHost: string;
  wyomingPort: number;
  /** v0.9.70 — optional Piper voice override (e.g. "en_US-amy-medium").
   *  Empty → use Piper add-on's configured default voice. */
  wyomingVoice: string | null;
  /** v0.12.1 — ms of silence prepended to each announcement so multi-room /
   *  AirPlay speakers can sync up before the chime (fixes clipped starts and
   *  slow AirPlay devices missing the announcement). 0 disables. */
  leadSilenceMs: number;
  /** v0.15.4 — repeat the whole (chime + spoken message) block N times per
   *  announcement so a missed first pass gets a second. Clamped 1..3. */
  repeat: number;
  /** v0.15.7 — silence (ms) inserted between the repeated blocks so the repeat
   *  is audibly distinct. Only applies when repeat > 1. Clamped 0..5000. */
  repeatGapMs: number;
  /** v0.15.15 — silence (ms) after the chime group, before the spoken message,
   *  so the chime decays before the announcement begins. Clamped 0..5000. */
  chimeGapMs: number;
  /** v0.15.4 — announce volume 0..100, or null to OMIT announce_volume entirely
   *  (play at the speaker's standing volume). Omitting it avoids MA's
   *  set→play→restore dance, which ecobee speakers handle unreliably. */
  announceVolume: number | null;
  /** v0.15.4 — MA's pre-announce tone; can "wake" a sleepy ecobee speaker. */
  usePreAnnounce: boolean;
  /** v0.15.4 — retry the play_announcement call on an actual failure (0..3). */
  announceRetries: number;
  /** v0.61.0 — append a spoken "End of message" terminator to the FINAL play of
   *  each announcement so the operator hears a clear close. Default on. */
  endOfMessage: boolean;
  /** v0.61.0 — the terminator phrase. Blank disables it. Default 'End of message'. */
  endOfMessagePhrase: string;
  /** v0.61.0 — silence (ms) before the terminator on the final block. 0..5000. */
  endOfMessageGapMs: number;
  /** v0.62.0 — play a SECOND pass of each announcement in another language (the
   *  message in English, then in Spanish). Active only when a second-language
   *  voice is configured; otherwise a no-op (English only). Default on. */
  bilingual: boolean;
  /** v0.62.0 — the second-language Piper/Wyoming voice (e.g. "es_MX-claude-high").
   *  EMPTY → bilingual inactive (the voice must exist on the Wyoming server). */
  secondLangVoice: string;
  /** v0.62.0 — the Spanish "End of message" terminator, used on the final
   *  (Spanish) pass of a bilingual announcement. Default "Fin del mensaje". */
  endOfMessagePhraseEs: string;
}

export function loadBroadcastConfig(): BroadcastConfig {
  const targetsRaw = process.env.BROADCAST_TARGETS ?? '';
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('media_player.'));
  // v0.18.0 — the env vars set the BASELINE; the /data runtime override (set
  // live from the UI) wins when present. We re-read it here on every call, and
  // loadBroadcastConfig is itself re-read each tick + per broadcast, so a UI
  // change takes effect within one tick with no restart.
  const envEnabled = process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1';
  const envVolume = clamp01(Number(process.env.BROADCAST_VOLUME ?? 0.5));
  const ov = getBroadcastRuntimeConfig();
  const enabled = ov.enabled != null ? ov.enabled : envEnabled;
  const volume = ov.volume != null ? clamp01(ov.volume) : envVolume;
  return {
    enabled,
    targets,
    audioBase: (process.env.BROADCAST_AUDIO_BASE || 'http://homeassistant.local:8787').replace(/\/$/, ''),
    volume,
    minSeverity: (process.env.BROADCAST_MIN_SEVERITY ?? 'critical') === 'warning' ? 'warning' : 'critical',
    quietHours: parseQuietHours(process.env.BROADCAST_QUIET_HOURS ?? ''),
    criticalBreakThrough:
      process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1',
    wyomingHost: process.env.BROADCAST_WYOMING_HOST || 'core-piper',
    wyomingPort: Number(process.env.BROADCAST_WYOMING_PORT) || 10200,
    wyomingVoice: emptyToNull(process.env.BROADCAST_WYOMING_VOICE),
    leadSilenceMs: clampLeadSilenceMs(process.env.BROADCAST_LEAD_SILENCE_MS),
    repeat: clampIntEnv(process.env.BROADCAST_REPEAT, 2, 1, 3),
    repeatGapMs: clampIntEnv(process.env.BROADCAST_REPEAT_GAP_MS, 1500, 0, 5000),
    chimeGapMs: clampIntEnv(process.env.BROADCAST_CHIME_GAP_MS, 1000, 0, 5000),
    // CRITICAL: announceVolume (0..100) is what actually reaches the speakers —
    // cfg.volume is never sent. Feed the EFFECTIVE (override-aware) volume into
    // the announce-volume resolver so the UI slider is audible. An explicit
    // BROADCAST_ANNOUNCE_VOLUME (a number or 'off'/'standing') still wins, by
    // design — that advanced reliability override pins the announce volume.
    announceVolume: resolveAnnounceVolume(process.env.BROADCAST_ANNOUNCE_VOLUME, volume),
    usePreAnnounce: process.env.BROADCAST_USE_PRE_ANNOUNCE === 'true' || process.env.BROADCAST_USE_PRE_ANNOUNCE === '1',
    announceRetries: clampIntEnv(process.env.BROADCAST_ANNOUNCE_RETRIES, 1, 0, 3),
    // v0.61.0 — "End of message" terminator. ON by default (the user asked for it
    // on every message); BROADCAST_END_OF_MESSAGE=false|0 disables it, as does a
    // blank BROADCAST_END_OF_MESSAGE_PHRASE.
    endOfMessage: !(process.env.BROADCAST_END_OF_MESSAGE === 'false' || process.env.BROADCAST_END_OF_MESSAGE === '0'),
    // Trim at load so the resolved value matches what renderAnnouncement actually
    // speaks (it trims too) — keeps the status payload + cache-key honest.
    endOfMessagePhrase: (process.env.BROADCAST_END_OF_MESSAGE_PHRASE ?? END_OF_MESSAGE_PHRASE).trim(),
    endOfMessageGapMs: clampIntEnv(process.env.BROADCAST_END_OF_MESSAGE_GAP_MS, END_OF_MESSAGE_GAP_MS, 0, 5000),
    // v0.62.0 — bilingual second pass (English then Spanish). ON by default but a
    // NO-OP until a Spanish voice is configured (BROADCAST_WYOMING_VOICE_ES), since
    // that voice must be installed on the Wyoming/Piper server. Disable explicitly
    // with BROADCAST_BILINGUAL=false|0.
    bilingual: !(process.env.BROADCAST_BILINGUAL === 'false' || process.env.BROADCAST_BILINGUAL === '0'),
    secondLangVoice: (process.env.BROADCAST_WYOMING_VOICE_ES ?? '').trim(),
    endOfMessagePhraseEs: (process.env.BROADCAST_END_OF_MESSAGE_PHRASE_ES ?? 'Fin del mensaje').trim(),
  };
}

/** v0.15.4 — clamp an integer env to [lo,hi]; empty/non-numeric → def. */
function clampIntEnv(raw: string | undefined, def: number, lo: number, hi: number): number {
  const n = raw == null || raw.trim() === '' ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** v0.15.4 — announce volume: 'off'/'none'/'standing' → null (omit announce_volume,
 *  play at the speaker's standing level — more reliable on ecobees); a 0..100
 *  number → that; empty → fallback (BROADCAST_VOLUME × 100). */
function resolveAnnounceVolume(raw: string | undefined, fallbackVol01: number): number | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'standing') return null;
  if (v !== '' && Number.isFinite(Number(v))) return Math.max(0, Math.min(100, Math.round(Number(v))));
  return Math.round(fallbackVol01 * 100);
}

/** v0.24.1 — the device standing-volume (0..1) to pin before an announcement,
 *  derived from the SAME announceVolume (0..100) that is sent as announce_volume.
 *  null (the 'standing'/'off' escape hatch) → don't touch the speaker volume.
 *  This is not a competing volume source — both knobs carry one value — it just
 *  guarantees RAOP/ecobee speakers that ignore announce_volume still play at the
 *  configured loudness instead of a drifted-low standing volume. */
export function announceVolumeLevel(announceVolume: number | null): number | null {
  if (announceVolume == null) return null;
  return Math.max(0, Math.min(1, announceVolume / 100));
}

/** v0.12.1 — lead-in silence (ms), default 1000, clamped to 0–5000. Non-numeric
 *  or empty → the 1000 ms default. */
function clampLeadSilenceMs(raw: string | undefined): number {
  // v0.23.0 — default raised 1000 → 1500 ms. Music Assistant 2.9 reworked the
  // AirPlay RAOP sync / flow-stream buffering (#3637), starting the first
  // audible frame sooner, so 1000 ms no longer fully covers slow AirPlay
  // receivers (ecobee) and the chime's leading edge was getting clipped. 1500 ms
  // restores the margin; the knob is now also tunable (BROADCAST_LEAD_SILENCE_MS
  // is exported by the run-script as of v0.23.0).
  const n = raw == null || raw.trim() === '' ? 1500 : Number(raw);
  if (!Number.isFinite(n)) return 1500;
  return Math.max(0, Math.min(5000, Math.round(n)));
}

function emptyToNull(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/* ─── condition derivation ────────────────────────────────────────── */

export type ConditionLevel = 'green' | 'yellow' | 'red';

export function conditionFromAlerts(alerts: Alert[]): { level: ConditionLevel; crit: number; warn: number } {
  // v0.12.0 — drop on-screen backup-SoC alerts (id starts with 'backup-soc')
  // before counting crit/warn. Their audible is the dedicated announce() path,
  // so excluding them here keeps the condition-transition broadcast from
  // double-chiming the same SoC crossing.
  // v0.14.0 — also drop the on-screen runway depletion alert (`forecast-runtime-*`):
  // its audible is now the dedicated runwayAlarm.announce() path, so excluding it
  // here keeps the condition-transition broadcast from double-chiming the same
  // projected depletion (mirrors the backup-soc exclusion above).
  // v0.16.4 — alerts explicitly flagged non-annunciating (annunciate === false,
  // e.g. an expected-offline bench spare) stay visible in the UI but must never
  // raise the broadcast condition level. Drop them before counting crit/warn so
  // they can't trigger a chime/broadcast — same intent as the backup-soc /
  // forecast-runtime exclusions above.
  // v0.23.0 — also drop 'shp2-below-reserve'. Its audible at the reserve floor is
  // the dedicated, grid-aware runwayAlarm.announce() path; and its severity now
  // FLIPS critical↔info with grid backstopping (alerts.ts). Counting it here would
  // make a grid transition raise/clear the broadcast condition and fire a spurious
  // red (or all-clear green) chime for a state change the runway alarm already owns.
  const counted = alerts.filter(
    (a) =>
      a.annunciate !== false &&
      !a.id.startsWith('backup-soc') &&
      !a.id.startsWith('shp2-below-reserve') &&
      !a.id.startsWith('forecast-runtime'),
  );
  const crit = counted.filter((a) => a.severity === 'critical').length;
  const warn = counted.filter((a) => a.severity === 'warning').length;
  const level: ConditionLevel = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green';
  return { level, crit, warn };
}

// v0.58.0 — how long after boot the restart-continuation gate stays armed. Learned/
// analytics alerts take ~1-2 min to re-warm post-restart, so a still-active
// pre-restart condition re-appears as a "rise" minutes after boot; mirror the
// notify path's warm-up grace. Env-tunable.
const BROADCAST_BOOT_WARMUP_MS = Number(process.env.BROADCAST_BOOT_WARMUP_MS) || 10 * 60 * 1000;

/**
 * v0.58.0 — a restart must not re-broadcast (re-speak aloud) a YELLOW/GREEN
 * condition that was already active and broadcast before the restart, even
 * though analytics warm-up makes it re-appear as a fresh transition. Returns true
 * (suppress) only for a yellow/green observation at or below the persisted
 * pre-restart `baseline`, within the post-boot warm-up window.
 *
 * SAFETY: a RED (critical) observation is NEVER a continuation — it always
 * returns false and broadcasts. Two reasons: (1) a critical that is still active
 * across a restart SHOULD be re-announced; (2) the broadcast path is level-based
 * with no alert identity, so a NEW, distinct critical firing during the warm-up
 * window while a pre-restart red was already active would otherwise be swallowed
 * by a same-rank (red≤red) match — an unacceptable risk of muting a fresh
 * emergency. The observed restart re-speak bug was a YELLOW advisory; that is all
 * we suppress. Pure + exported for tests.
 */
export function isRestartContinuation(
  baseline: ConditionLevel | null,
  observed: ConditionLevel,
  msSinceBoot: number,
  windowMs = BROADCAST_BOOT_WARMUP_MS,
): boolean {
  if (baseline == null) return false;        // first-ever boot / no verified prior broadcast → today's behaviour
  if (msSinceBoot >= windowMs) return false; // past the warm-up window → normal transitions resume
  if (observed === 'red') return false;      // SAFETY: never suppress a critical (re-announce; never mute a new one)
  const RANK = { green: 0, yellow: 1, red: 2 } as const;
  return RANK[observed] <= RANK[baseline];   // a same-or-lower yellow/green ⇒ continuation
}

/* ─── monitor ─────────────────────────────────────────────────────── */

export interface BroadcastMonitor {
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[]; cooldownRemainingMs?: number }>;
  /**
   * v0.11.0 — render (and optionally play) a per-priority preview announcement
   * for the Alert Settings page. `target: 'browser'` renders only and returns
   * the WAV path for the browser to play via apiUrl(audioPath); `target:
   * 'speakers'` ALSO plays it to the configured Music Assistant targets.
   */
  preview: (
    priority: AlarmPriority,
    target: 'browser' | 'speakers',
  ) => Promise<{
    ok: boolean;
    spokenText: string;
    audioPath?: string;
    played: 'browser' | 'speakers';
    error?: string;
    cooldownRemainingMs?: number;
  }>;
  /**
   * v0.12.0 — fire a dedicated, edge-triggered audible announcement for one
   * backup-pool SoC threshold crossing. Renders chime(klaxonLevelForPriority)
   * ×getChimeRepeat() + spoken `message` and plays it to BROADCAST_TARGETS via
   * the SAME Music-Assistant path as runBroadcast()/test(). The SoC monitor
   * already edge-limits crossings, so this skips test()/preview() cooldowns.
   * No-ops (returns { ok:false, error:'broadcast disabled' }) when BROADCAST
   * is off. Never throws.
   */
  announce: (priority: AlarmPriority, message: string, messageEs?: string) => Promise<{ ok: boolean; error?: string }>;
  config: () => BroadcastConfig;
  status: () => BroadcastStatus;
  stop: () => void;
}

export interface BroadcastStatus {
  supervised: boolean;
  enabled: boolean;
  targetCount: number;
  targets: string[];
  lastBroadcastAt: number | null;
  lastLevel: ConditionLevel | null;
  lastOutcome: 'success' | 'partial' | 'failure' | null;
  lastErrors: string[];
  /** Whether MA's announce service is reachable from HA. */
  musicAssistantAvailable: boolean;
  /** Whether the Wyoming server responded to our last render attempt. */
  wyomingReachable: boolean | null;
  testCooldownRemainingMs: number;
  lastSpokenMessage: string | null;
  /** v0.29.0 — cumulative count of broadcasts the storm gate suppressed (an
   *  identical message, or a same-or-lower level, within the cooldown). Resets on
   *  restart; surfaced for operability so audible suppression is observable from
   *  /api/broadcast/status. Escalations always bypass the gate, so a genuinely new
   *  critical is never counted here. */
  stormSuppressedCount: number;
  /** v0.9.70 — diagnostic from the most recent render. */
  lastRender: {
    filename: string | null;
    sizeBytes: number | null;
    ttsRenderMs: number | null;
    fromCache: boolean | null;
    error: string | null;
  };
}

const TEST_COOLDOWN_MS = 10_000;
/** v0.11.0 — separate, short cooldown for per-priority previews. Previews are
 *  cheap (cache-aware render) and the operator may want to audition several in
 *  a row, so they do NOT share the test endpoint's 10s cooldown. */
const PREVIEW_COOLDOWN_MS = 2_000;
/** Prune cached announcements older than this on each tick. 7 days
 *  comfortably covers repeated identical alerts within a week without
 *  letting cruft pile up indefinitely. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BroadcastMonitorOpts {
  /** Directory containing the pre-generated klaxon WAVs (e.g. /data/audio). */
  klaxonDir: string;
  /** Directory to cache combined announcement WAVs. */
  cacheDir: string;
  /** URL path the speakers fetch combined WAVs from. Joined with audioBase. */
  cacheUrlPath: string;
}

export function startBroadcastMonitor(
  store: SnapshotStore,
  log: (m: string) => void,
  opts: BroadcastMonitorOpts,
): BroadcastMonitor {
  let cfg = loadBroadcastConfig();
  // v0.18.0 — keep the closure `cfg` coherent the instant a runtime override is
  // written (updateBroadcastRuntimeConfig notifies synchronously), so
  // broadcast.config() — consumed by /api/broadcast/config + /api/broadcast/
  // status — reflects a UI enable/volume toggle immediately, not at the next
  // ~10s tick. The audible path already reloads per tick/broadcast; this is for
  // read coherence.
  const offRuntimeConfig = onBroadcastRuntimeConfigChange(() => { cfg = loadBroadcastConfig(); });
  let prevLevel: ConditionLevel | null = null;
  let prevCrit = 0;
  let firstTick = true;
  let stopped = false;
  let lastBroadcastAt: number | null = null;
  let lastLevel: ConditionLevel | null = null;
  let lastOutcome: BroadcastStatus['lastOutcome'] = null;
  let lastErrors: string[] = [];
  let lastTestAt = 0;
  let lastPreviewAt = 0; // v0.11.0 — per-priority preview cooldown gate.
  let musicAssistantAvailable = false;
  let wyomingReachable: boolean | null = null;
  let lastSpokenMessage: string | null = null;
  let lastRender: BroadcastStatus['lastRender'] = {
    filename: null, sizeBytes: null, ttsRenderMs: null, fromCache: null, error: null,
  };

  // v0.15.18 — the last-broadcast summary survives restarts. Before this,
  // every deploy blanked lastBroadcastAt/lastOutcome/lastSpokenMessage, so
  // "what played last and did it work" was unanswerable right after the
  // restarts that most need auditing.
  const STATUS_PATH = resolve(process.cwd(), config.dbPath, '..', 'broadcast-last.json');
  const persistStatus = () => {
    try {
      writeFileSync(
        STATUS_PATH,
        JSON.stringify({ lastBroadcastAt, lastLevel, lastOutcome, lastErrors, lastSpokenMessage, lastRender }),
      );
    } catch { /* best-effort */ }
  };
  try {
    const s = JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as Partial<{
      lastBroadcastAt: number; lastLevel: ConditionLevel; lastOutcome: BroadcastStatus['lastOutcome'];
      lastErrors: string[]; lastSpokenMessage: string; lastRender: BroadcastStatus['lastRender'];
    }>;
    lastBroadcastAt = s.lastBroadcastAt ?? null;
    lastLevel = s.lastLevel ?? null;
    lastOutcome = s.lastOutcome ?? null;
    lastErrors = Array.isArray(s.lastErrors) ? s.lastErrors : [];
    lastSpokenMessage = s.lastSpokenMessage ?? null;
    if (s.lastRender) lastRender = s.lastRender;
  } catch { /* first boot / no prior state */ }
  // v0.58.0 — restart-continuation baseline (used only to suppress a re-spoken
  // YELLOW/GREEN advisory; criticals are never suppressed — see isRestartContinuation).
  // Only adopt the persisted level when the last broadcast actually SUCCEEDED (the
  // operator heard it); a failed/never-played pre-restart broadcast must still re-fire.
  const bootMs = Date.now();
  const bootBaselineLevel: ConditionLevel | null = lastOutcome === 'success' ? lastLevel : null;

  // v0.15.18 — single-slot deferred retry for broadcasts that could not be
  // verified (targets unavailable during an HA/MA restart, MA call failure,
  // or a "completed" too fast for any audio to have played). A new genuine
  // broadcast supersedes the pending retry.
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  const RETRY_DELAYS_MS = [30_000, 90_000, 180_000];
  const scheduleBroadcastRetry = (level: ConditionLevel, message: string | null, messageEs: string | null, reason: string) => {
    if (retryAttempt >= RETRY_DELAYS_MS.length) {
      log(`broadcast: giving up after ${retryAttempt} deferred retries (${reason})`);
      retryAttempt = 0;
      return;
    }
    const delay = RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    if (retryTimer) clearTimeout(retryTimer);
    log(`broadcast: ${reason} — deferred retry ${retryAttempt}/${RETRY_DELAYS_MS.length} in ${Math.round(delay / 1000)}s`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      // v0.18.0 — a deferred retry is an AUTOMATIC condition-transition
      // broadcast, so it must honour the same enable gate as tick(). With
      // BROADCAST_ENABLED now live-mutable from the UI, an operator who disables
      // broadcasts must not hear a retry that was armed before they disabled.
      // (test()/preview() are explicit operator actions and intentionally
      // bypass this — they call runBroadcast directly, not via this timer.)
      cfg = loadBroadcastConfig();
      if (!cfg.enabled) {
        log('broadcast: deferred retry cancelled — broadcasts disabled');
        retryAttempt = 0;
        return;
      }
      void runBroadcast(level, message, false, messageEs);
    }, delay);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  // v0.15.22 — alarm-storm gates. The Jun 12 EV-charging-on-33% event fired 5
  // audible broadcasts in 50 min from THREE independent sources (runway alarm,
  // SoC alarm, alert pipeline); overlapping 30-70 s MA announcements then
  // wedged Music Assistant into HTTP 500s and the household heard the same
  // critical message 4+ times. Two gates, both bypassed by a genuine
  // ESCALATION (a level higher than the last thing that actually played):
  //   - identical spoken message within SAME_MESSAGE_GAP_MS → suppressed
  //     (tier-boundary flapping repeats the exact same text);
  //   - any same-or-lower level within SAME_LEVEL_GAP_MS → suppressed
  //     (at most one non-escalating voice alarm per gap).
  // Gates key off the last VERIFIED playback, so failed/unverified dispatches
  // never block their own retries. Test/preview paths bypass (deliberate).
  const SAME_LEVEL_GAP_MS = 2 * 60 * 1000;
  const SAME_MESSAGE_GAP_MS = 10 * 60 * 1000;
  const LEVEL_RANK: Record<ConditionLevel, number> = { green: 0, yellow: 1, red: 2 };
  let lastPlayedAt = 0;
  let lastPlayedLevel: ConditionLevel | null = null;
  let lastPlayedMessage: string | null = null;
  let stormSuppressedCount = 0;

  const supervised = isSupervised();
  if (!supervised) {
    log('broadcast: SUPERVISOR_TOKEN not set; running outside HA, broadcasts disabled');
  } else if (!cfg.enabled) {
    log('broadcast: disabled (set BROADCAST_ENABLED=true to opt in)');
  } else if (cfg.targets.length === 0) {
    log('broadcast: no targets configured (set BROADCAST_TARGETS to comma-separated media_player entity IDs)');
  } else {
    log(`broadcast: enabled, ${cfg.targets.length} target(s): ${cfg.targets.join(', ')}`);
  }

  // v0.9.80 — avoid a startup false-negative. At boot the Supervisor proxy /
  // Core service registry may not be ready, so the services-catalog fetch
  // fails and looks identical to "MA not installed". probeService() returns
  // 'unknown' for a failed/early fetch (vs 'absent' for a confirmed-empty
  // catalog), so we only emit the alarming "broadcasts will fail" line on a
  // CONFIRMED absence. Transient 'unknown' results are retried a few times,
  // then logged quietly — the next check (tick/test endpoint) re-probes once
  // Core is warm and will flip availability + log "detected". The 42h log
  // showed both the false "NOT detected" at boot AND a later "detected".
  const detectMusicAssistant = async (opts?: { retries?: number; retryDelayMs?: number }) => {
    if (!supervised) {
      musicAssistantAvailable = false;
      return;
    }
    const retries = opts?.retries ?? 5;
    const retryDelayMs = opts?.retryDelayMs ?? 3000;
    let result: 'present' | 'absent' | 'unknown' = 'unknown';
    for (let attempt = 0; attempt <= retries; attempt++) {
      result = await probeService('music_assistant', 'play_announcement');
      if (result !== 'unknown') break; // definitive answer
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        if (stopped) return;
      }
    }
    musicAssistantAvailable = result === 'present';
    if (result === 'present') {
      log('broadcast: music_assistant.play_announcement detected');
    } else if (result === 'absent') {
      // Confirmed: catalog retrieved, MA's service genuinely not in it.
      log('broadcast: music_assistant.play_announcement NOT detected — broadcasts will fail until MA is installed');
    } else {
      // Never got a confirmed catalog (Core/Supervisor not ready). Stay calm;
      // the periodic test/manual re-check resolves this once HA is up.
      log('broadcast: music_assistant.play_announcement check inconclusive at startup (HA service registry not ready yet); will re-check on next broadcast/test');
    }
  };

  void detectMusicAssistant();

  const inQuiet = (): boolean => {
    if (!cfg.quietHours) return false;
    return inQuietWindow(new Date(), cfg.quietHours);
  };

  /**
   * v0.15.4 — issue the Music-Assistant announcement to all configured targets,
   * honoring the announce-volume mode (omit when null → play at the speaker's
   * standing volume, which is more reliable on ecobee speakers) and the optional
   * pre-announce wake tone, with up to cfg.announceRetries retries on an actual
   * call failure. Targets are always exactly cfg.targets (BROADCAST_TARGETS).
   */
  const playAnnounce = async (url: string): Promise<{ ok: boolean; error?: string }> => {
    // v0.24.1 — pin each target's STANDING volume from config BEFORE announcing.
    // RAOP/AirPlay speakers (ecobee in particular) handle MA's announce_volume
    // set→play→restore unreliably and fall back to their standing volume — which
    // can silently drift low (re-provisioning an ecobee's AirPlay receiver resets
    // it to ~0.2, e.g. after moving it from Apple Home to HA). Setting the standing
    // volume here makes BROADCAST_VOLUME authoritative regardless of whether the
    // speaker honors announce_volume. Best-effort: a volume_set failure never
    // blocks the announcement. Skipped when announce volume is 'standing'/'off'
    // (the explicit manual-volume escape hatch → leave the speaker as-is).
    const standingLevel = announceVolumeLevel(cfg.announceVolume);
    if (standingLevel != null && cfg.targets.length > 0) {
      const vr = await callHaService('media_player', 'volume_set', { entity_id: cfg.targets, volume_level: standingLevel });
      if (!vr.ok) log(`broadcast: pre-announce volume_set to ${standingLevel} failed (continuing) — ${vr.error ?? vr.status}`);
      else await new Promise((res) => setTimeout(res, 300)); // let RAOP apply before the stream
    }

    const params: Record<string, unknown> = {
      entity_id: cfg.targets,
      url,
      use_pre_announce: cfg.usePreAnnounce,
    };
    if (cfg.announceVolume != null) params.announce_volume = cfg.announceVolume;
    let last: { ok: boolean; error?: string; status?: number } = { ok: false, error: 'no attempt' };
    for (let attempt = 0; attempt <= cfg.announceRetries; attempt++) {
      last = await callHaService('music_assistant', 'play_announcement', params);
      if (last.ok) return { ok: true };
      if (attempt < cfg.announceRetries) {
        log(`broadcast: play_announcement failed (attempt ${attempt + 1}/${cfg.announceRetries + 1}), retrying — ${last.error ?? last.status}`);
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return { ok: false, error: `${last.error ?? last.status}` };
  };

  /**
   * Single broadcast: render → one MA call. No staggering, no settles.
   */
  const runBroadcastInner = async (
    level: ConditionLevel,
    message: string | null,
    messageEs: string | null,
    bypassStormGate: boolean,
  ): Promise<{ ok: boolean; errors: string[] }> => {
    if (!supervised) return { ok: false, errors: ['not supervised'] };
    if (cfg.targets.length === 0) return { ok: false, errors: ['no targets configured'] };

    // v0.15.22 — storm gates (see constants above). Escalations always play.
    if (!bypassStormGate && lastPlayedAt > 0) {
      const since = Date.now() - lastPlayedAt;
      const escalation = lastPlayedLevel == null || LEVEL_RANK[level] > LEVEL_RANK[lastPlayedLevel];
      if (!escalation) {
        if (message != null && message === lastPlayedMessage && since < SAME_MESSAGE_GAP_MS) {
          stormSuppressedCount += 1;
          log(`broadcast: ${level} suppressed — identical message played ${Math.round(since / 1000)}s ago (storm gate)`);
          return { ok: false, errors: ['suppressed: identical message within gap'] };
        }
        if (since < SAME_LEVEL_GAP_MS) {
          stormSuppressedCount += 1;
          log(`broadcast: ${level} suppressed — last ${lastPlayedLevel} played ${Math.round(since / 1000)}s ago (storm gate)`);
          return { ok: false, errors: ['suppressed: same-or-lower level within gap'] };
        }
      }
    }

    const errors: string[] = [];
    const t0 = Date.now();

    // 1. Render combined announcement WAV (cache-aware). v0.15.23 — resolve the
    // operator-assigned chime for this level (custom tone or built-in klaxon);
    // resolveChime falls back to the built-in when a custom file is missing.
    const chime = resolveChime(level as AnnouncementLevel, opts.klaxonDir);
    if (chime.fellBack) log(`broadcast: assigned custom chime for ${level} missing — using built-in klaxon`);
    // v0.62.0 — bilingual second pass: play the message in English, then in
    // Spanish. Active only when a Spanish voice is configured (the voice must
    // exist on the Wyoming server) AND a Spanish text was supplied AND there's an
    // English message. The bilingual pair REPLACES the announceRepeat repeat (the
    // two languages ARE the redundancy), and the terminator switches to its
    // Spanish phrase since the final pass is Spanish.
    const secondVoice = cfg.secondLangVoice.trim();
    const bilingual = cfg.bilingual
      && secondVoice.length > 0
      && message != null && message.trim().length > 0
      && messageEs != null && messageEs.trim().length > 0;
    const messages = bilingual
      ? [
          { text: message!, lang: 'en' as const },                       // English, default voice
          { text: messageEs!, lang: 'es' as const, voice: secondVoice },  // Spanish voice
        ]
      : undefined;
    const r = await renderAnnouncement({
      level,
      message,
      messages, // v0.62.0 — present → multi-language passes (English then Spanish)
      klaxonDir: opts.klaxonDir,
      chimePath: chime.path,
      chimeTag: chime.tag,
      cacheDir: opts.cacheDir,
      wyomingHost: cfg.wyomingHost,
      wyomingPort: cfg.wyomingPort,
      wyomingVoice: cfg.wyomingVoice ?? undefined,
      leadSilenceMs: cfg.leadSilenceMs, // v0.12.1 — speakers sync before the chime
      announceRepeat: cfg.repeat, // v0.15.4 — repeat chime+message so a missed first pass gets a second (ignored when bilingual)
      repeatGapMs: cfg.repeatGapMs, // v0.15.7 — silence between repeats so the repeat is audible
      chimeGapMs: cfg.chimeGapMs, // v0.15.15 — pause after the chime before the spoken message
      endOfMessage: cfg.endOfMessage, // v0.61.0 — "End of message" terminator on the final play
      endOfMessagePhrase: cfg.endOfMessagePhrase, // v0.67.0 — English terminator rides the English pass
      endOfMessagePhraseEs: cfg.endOfMessagePhraseEs, // v0.67.0 — Spanish terminator rides the Spanish pass
      endOfMessageGapMs: cfg.endOfMessageGapMs,
      log,
    });
    lastRender = {
      filename: r.filename ?? null,
      sizeBytes: r.sizeBytes ?? null,
      ttsRenderMs: r.ttsRenderMs ?? null,
      fromCache: r.fromCache ?? null,
      error: r.error ?? null,
    };
    if (!r.ok || !r.filename) {
      // Render failed. If a message was requested but TTS broke, we COULD
      // fall through to klaxon-only by re-rendering with message=null.
      // For now: surface the error so it's visible and skip the broadcast.
      // The user can pin BROADCAST_TARGETS to "" to disable while
      // diagnosing without losing the alert pipeline.
      wyomingReachable = false;
      errors.push(`render: ${r.error ?? 'unknown'}`);
      return { ok: false, errors };
    }
    wyomingReachable = message ? true : wyomingReachable; // only "proved" by a TTS render

    // 2. v0.15.18 — pre-flight: during HA/MA restart windows the media_player
    // entities briefly deregister; HA then ACCEPTS play_announcement and
    // silently drops it (3 confirmed swallowed broadcasts, each "ok" in
    // 20-34 ms). Verify at least one target is registered and available
    // before dispatching; otherwise defer and retry.
    const states = await Promise.all(cfg.targets.map((t) => getEntityState(t)));
    const usable = states.filter((s) => s != null && s.state !== 'unavailable').length;
    if (usable === 0) {
      errors.push('all broadcast targets unavailable (HA/MA restarting?)');
      scheduleBroadcastRetry(level, message, messageEs, 'all broadcast targets unavailable');
      lastBroadcastAt = Date.now(); lastLevel = level; lastOutcome = 'failure'; lastErrors = errors;
      persistStatus();
      log(`broadcast: ${level} deferred — ${errors[0]}`);
      return { ok: false, errors };
    }

    // 3. Single MA play_announcement to every target.
    const url = `${cfg.audioBase}${opts.cacheUrlPath}/${r.filename}`;
    const call = await playAnnounce(url);
    if (!call.ok) {
      errors.push(`music_assistant.play_announcement: ${call.error}`);
      scheduleBroadcastRetry(level, message, messageEs, 'play_announcement failed after in-call retries');
    }

    if (message) lastSpokenMessage = message;

    const dt = Date.now() - t0;
    // v0.15.18 — a real MA announcement blocks until playback completes
    // (observed 17-34 s). A sub-2 s "ok" means HA returned without playing
    // (entity registered but its player not ready) — treat as unverified
    // and re-dispatch rather than report a success no one heard.
    if (call.ok && dt < 2000) {
      errors.push(`unverified: completed in ${dt}ms — too fast for real playback`);
      scheduleBroadcastRetry(level, message, messageEs, `suspiciously fast completion (${dt}ms)`);
    }
    if (call.ok && errors.length === 0) {
      retryAttempt = 0; // verified success resets the deferred-retry budget
      // v0.15.22 — storm gates key off VERIFIED playback only, so a failed or
      // unverified dispatch never blocks its own deferred retries.
      lastPlayedAt = Date.now();
      lastPlayedLevel = level;
      lastPlayedMessage = message;
    }
    const renderTag = r.fromCache ? 'cached' : `rendered+${r.ttsRenderMs}ms`;
    if (errors.length === 0) {
      log(`broadcast: ${level} → ok in ${dt}ms (${cfg.targets.length} targets, ${renderTag}, ${r.sizeBytes ?? '?'} bytes${message ? ', +tts' : ''})`);
    } else {
      log(`broadcast: ${level} → ${errors.length} error(s) in ${dt}ms: ${errors.join('; ')}`);
    }
    lastBroadcastAt = Date.now(); lastLevel = level;
    lastOutcome = errors.length === 0 ? 'success' : 'partial';
    lastErrors = errors;
    persistStatus();
    return { ok: errors.length === 0, errors };
  };

  // v0.15.22 — single-flight: every broadcast (runway alarm, SoC alarm, alert
  // pipeline, retries, tests) is serialized through one promise chain. A real
  // MA announcement blocks 30-70 s; three sources firing within minutes used
  // to OVERLAP play_announcement calls, which wedged Music Assistant into
  // HTTP 500s ("Server got itself in trouble", observed Jun 12 04:12Z). Now
  // a second request simply waits for the first playback to finish — and by
  // then the storm gates above usually (correctly) absorb it.
  let broadcastChain: Promise<unknown> = Promise.resolve();
  const runBroadcast = (
    level: ConditionLevel,
    message: string | null,
    bypassStormGate = false,
    messageEs: string | null = null,
  ): Promise<{ ok: boolean; errors: string[] }> => {
    const run = () => runBroadcastInner(level, message, messageEs, bypassStormGate);
    const p = broadcastChain.then(run, run);
    broadcastChain = p.catch(() => undefined);
    return p;
  };

  const messageFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    // No engine detection — Wyoming is always our TTS path. Return the
    // formatted message; the renderer hits Wyoming directly. If Wyoming
    // is offline the render fails cleanly and the broadcast logs an error.
    return buildAlertMessage(level, alerts);
  };

  // v0.62.0 — the Spanish (Latin American) second-pass text for the same
  // condition, mirroring messageFor. Built only when needed (bilingual active).
  const messageEsFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    return buildAlertMessageEs(level, alerts);
  };

  /* ── tick — periodic check for condition transitions */
  let tickInFlight = false;
  const tick = async () => {
    if (stopped) return;
    cfg = loadBroadcastConfig();
    // v0.11.0 — drop alerts whose ISA priority has been silenced on the Alert
    // Settings page BEFORE counting crit/warn, so a silenced priority never
    // raises the condition level (and thus never triggers a chime/broadcast).
    // The alerts stay in snapshot.alerts and remain visible in the UI — we only
    // gate the audible annunciation here.
    const alerts = ((store.get().alerts ?? []) as Alert[]).filter((a) => isPriorityEnabled(priorityOf(a)));
    const { level, crit } = conditionFromAlerts(alerts);
    if (firstTick) {
      firstTick = false;
      prevLevel = level;
      prevCrit = crit;
      return;
    }
    const transitioned = level !== prevLevel;
    const newCrit = level === 'red' && crit > prevCrit;
    // v0.58.0 — within the post-restart warm-up window, a condition that was
    // already active (and successfully broadcast) before the restart re-appears as
    // a "rise" once the analytics/learned alerts re-warm. Don't re-speak it aloud;
    // adopt the level silently. A genuine escalation above the pre-restart baseline
    // (e.g. yellow→red across the restart) still passes through and broadcasts.
    if (transitioned && isRestartContinuation(bootBaselineLevel, level, Date.now() - bootMs)) {
      log(`broadcast: ${level} matches pre-restart advisory — suppressing duplicate (restart continuation)`);
      prevLevel = level;
      prevCrit = crit;
      return;
    }
    if (!transitioned && !newCrit) return;
    // Snapshot the transition state FIRST so a second arrival during an
    // in-flight broadcast doesn't re-fire (preserved from v0.9.49).
    prevLevel = level;
    prevCrit = crit;
    if (!cfg.enabled) return;
    if (level === 'yellow' && cfg.minSeverity === 'critical') return;
    // v0.23.0 — yellow/green always respect quiet hours. red (a critical
    // condition) breaks through ONLY when the operator opted in; default OFF ⇒
    // red is also suppressed overnight (the alert stays visible on-screen, and
    // the push path queues it for the morning digest).
    if (inQuiet() && !(level === 'red' && cfg.criticalBreakThrough)) {
      log(`broadcast: ${level} suppressed by quiet hours`);
      return;
    }
    if (tickInFlight) {
      log(`broadcast: ${level} skipped — previous broadcast still in flight`);
      return;
    }
    tickInFlight = true;
    try {
      log(`broadcast: condition transition → ${level}${newCrit ? ' (new crit)' : ''}, ${cfg.targets.length} target(s)`);
      const message = messageFor(level, alerts);
      const messageEs = messageEsFor(level, alerts); // v0.62.0 — Spanish second pass
      const result = await runBroadcast(level, message, false, messageEs);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = result.ok ? 'success' : 'partial';
      lastErrors = result.errors;
    } finally {
      tickInFlight = false;
    }
  };

  /* ── prune — periodic cache cleanup. Runs once per hour. */
  const prune = async () => {
    if (stopped) return;
    try {
      await pruneRenderCache(opts.cacheDir, CACHE_MAX_AGE_MS, log);
    } catch (e: any) {
      log(`broadcast: prune failed: ${e?.message ?? e}`);
    }
  };

  const tickInterval = setInterval(() => { tick().catch((e) => log(`broadcast: tick failed: ${e?.message ?? e}`)); }, 10_000);
  const pruneInterval = setInterval(() => { void prune(); }, 60 * 60 * 1000);
  tickInterval.unref();
  pruneInterval.unref();

  return {
    test: async (level: ConditionLevel = 'red') => {
      cfg = loadBroadcastConfig();
      const remaining = Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now());
      if (remaining > 0) {
        return {
          ok: false,
          messages: [`cooldown: wait ${Math.ceil(remaining / 1000)}s before testing again`],
          cooldownRemainingMs: remaining,
        };
      }
      lastTestAt = Date.now();
      await detectMusicAssistant();
      // v0.11.0 — test announcements use the same ISA priority vocabulary as
      // real alarms (was the colour-named "Red alert"/"Yellow alert").
      const message =
        // v0.15.16 — the alert type leads, mirroring real announcements, so a
        // test rehearses exactly what the operator will hear in earnest.
        level === 'red' ? `${priorityAnnouncementPrefix('critical')} Test broadcast. This is only a test.` :
        level === 'yellow' ? `${priorityAnnouncementPrefix('medium')} Test broadcast. This is only a test.` :
        'All clear. Test broadcast. This is only a test.';
      // v0.62.0 — the Spanish second pass for a test, so a test rehearses the
      // full bilingual announcement when a Spanish voice is configured.
      const messageEs =
        level === 'red' ? `${priorityAnnouncementPrefixEs('critical')} Transmisión de prueba. Esto es solo una prueba.` :
        level === 'yellow' ? `${priorityAnnouncementPrefixEs('medium')} Transmisión de prueba. Esto es solo una prueba.` :
        'Todo despejado. Transmisión de prueba. Esto es solo una prueba.';
      // bypassStormGate — a test is operator-initiated and must always play.
      const r = await runBroadcast(level, message, true, messageEs);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = r.ok ? 'success' : 'partial';
      lastErrors = r.errors;
      return {
        ok: r.ok,
        messages: r.errors,
        cooldownRemainingMs: TEST_COOLDOWN_MS,
      };
    },
    // v0.11.0 — render (browser) or render+play (speakers) a per-priority
    // preview announcement for the Alert Settings page. Uses the SAME
    // renderAnnouncement(...) call as test()/runBroadcast so the audio (chime
    // repeat + TTS) is identical to what a real alarm would sound like.
    preview: async (priority: AlarmPriority, target: 'browser' | 'speakers') => {
      cfg = loadBroadcastConfig();
      const spokenText = previewMessageFor(priority);
      const level = klaxonLevelForPriority(priority);

      // Short, preview-only cooldown — independent of test()'s 10s gate.
      const remaining = Math.max(0, lastPreviewAt + PREVIEW_COOLDOWN_MS - Date.now());
      if (remaining > 0) {
        return {
          ok: false,
          spokenText,
          played: target,
          error: `cooldown: wait ${Math.ceil(remaining / 1000)}s before previewing again`,
          cooldownRemainingMs: remaining,
        };
      }
      lastPreviewAt = Date.now();

      // 1. Render combined klaxon + TTS WAV (cache-aware), exactly like
      //    runBroadcast. This works even when broadcasts are disabled / no
      //    targets are configured — a browser-target preview never touches MA.
      // v0.15.23 — preview must audition the SAME chime real broadcasts use,
      // so resolve it here too (otherwise a preview plays the built-in while a
      // real alarm plays the custom tone).
      const previewChime = resolveChime(level as AnnouncementLevel, opts.klaxonDir);
      const r = await renderAnnouncement({
        level,
        message: spokenText,
        klaxonDir: opts.klaxonDir,
        chimePath: previewChime.path,
        chimeTag: previewChime.tag,
        cacheDir: opts.cacheDir,
        wyomingHost: cfg.wyomingHost,
        wyomingPort: cfg.wyomingPort,
        wyomingVoice: cfg.wyomingVoice ?? undefined,
        leadSilenceMs: cfg.leadSilenceMs, // v0.12.1 — speakers sync before the chime
        announceRepeat: cfg.repeat, // v0.15.4 — repeat chime+message so a missed first pass gets a second
        repeatGapMs: cfg.repeatGapMs, // v0.15.7 — silence between repeats so the repeat is audible
        chimeGapMs: cfg.chimeGapMs, // v0.15.15 — pause after the chime before the spoken message
        endOfMessage: cfg.endOfMessage, // v0.61.0 — "End of message" terminator on the final play
        endOfMessagePhrase: cfg.endOfMessagePhrase,
        endOfMessagePhraseEs: cfg.endOfMessagePhraseEs, // v0.67.0 — per-language terminator (English-only preview ignores it)
        endOfMessageGapMs: cfg.endOfMessageGapMs,
        log,
      });
      lastRender = {
        filename: r.filename ?? null,
        sizeBytes: r.sizeBytes ?? null,
        ttsRenderMs: r.ttsRenderMs ?? null,
        fromCache: r.fromCache ?? null,
        error: r.error ?? null,
      };
      if (!r.ok || !r.filename) {
        wyomingReachable = false;
        return { ok: false, spokenText, played: target, error: `render: ${r.error ?? 'unknown'}` };
      }
      wyomingReachable = true; // a TTS render succeeded
      lastSpokenMessage = spokenText;
      // Path is relative (no leading slash) so the browser fetches it via
      // apiUrl(audioPath); the server serves it at /audio-render/<file>.
      const audioPath = `audio-render/${r.filename}`;

      // 2. Browser target → render only; the web app plays the WAV itself.
      if (target === 'browser') {
        return { ok: true, spokenText, audioPath, played: 'browser' };
      }

      // 3. Speakers target → ALSO play to the configured MA targets, exactly
      //    like test()/runBroadcast.
      if (!supervised) {
        return { ok: false, spokenText, audioPath, played: 'speakers', error: 'not supervised' };
      }
      if (cfg.targets.length === 0) {
        return { ok: false, spokenText, audioPath, played: 'speakers', error: 'no targets configured' };
      }
      await detectMusicAssistant();
      const url = `${cfg.audioBase}${opts.cacheUrlPath}/${r.filename}`;
      const call = await playAnnounce(url);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      if (!call.ok) {
        const err = `music_assistant.play_announcement: ${call.error}`;
        lastOutcome = 'partial';
        lastErrors = [err];
        return { ok: false, spokenText, audioPath, played: 'speakers', error: err };
      }
      lastOutcome = 'success';
      lastErrors = [];
      log(`broadcast: preview ${priority} (${level}) → played to ${cfg.targets.length} target(s)`);
      return { ok: true, spokenText, audioPath, played: 'speakers' };
    },
    // v0.12.0 — dedicated audible for one backup-SoC threshold crossing. Maps
    // priority → klaxon level, then reuses runBroadcast() so the render (chime
    // ×getChimeRepeat() + TTS) and the Music-Assistant play path are IDENTICAL
    // to a real condition-transition broadcast. The SoC monitor edge-limits
    // crossings, so we deliberately apply NO cooldown here. Never throws.
    announce: async (priority: AlarmPriority, message: string, messageEs?: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        cfg = loadBroadcastConfig();
        if (!cfg.enabled) return { ok: false, error: 'broadcast disabled' };
        // v0.14.0 — quiet-hours gate for the advisory/caution tiers. Low and
        // Medium (e.g. the 50/40% SoC advisories and the reserve-runway caution)
        // stay silent during quiet hours.
        // v0.23.0 — High and Critical (near-empty SoC, projected-empty runway)
        // now break through ONLY when the operator opted in via
        // CRITICAL_BREAKS_QUIET_HOURS. Default OFF ⇒ every tier is held overnight
        // (the on-screen alert still shows and the morning digest carries the
        // push), so a genuine overnight emergency does not wake the household
        // unless they asked it to.
        const tierBreaksThrough =
          (priority === 'high' || priority === 'critical') && cfg.criticalBreakThrough;
        if (inQuiet() && !tierBreaksThrough) {
          return { ok: false, error: 'suppressed: quiet hours' };
        }
        const level = klaxonLevelForPriority(priority);
        const r = await runBroadcast(level, message, false, messageEs ?? null);
        lastBroadcastAt = Date.now();
        lastLevel = level;
        lastOutcome = r.ok ? 'success' : 'partial';
        lastErrors = r.errors;
        return r.ok ? { ok: true } : { ok: false, error: r.errors.join('; ') || 'broadcast failed' };
      } catch (e: any) {
        const err = e?.message ?? String(e);
        log(`broadcast: announce failed: ${err}`);
        return { ok: false, error: err };
      }
    },
    config: () => cfg,
    status: () => ({
      supervised,
      enabled: cfg.enabled,
      targetCount: cfg.targets.length,
      targets: cfg.targets,
      lastBroadcastAt,
      lastLevel,
      lastOutcome,
      lastErrors,
      musicAssistantAvailable,
      wyomingReachable,
      testCooldownRemainingMs: Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now()),
      lastSpokenMessage,
      stormSuppressedCount,
      lastRender: { ...lastRender },
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
      clearInterval(pruneInterval);
      offRuntimeConfig();
    },
  };
}
