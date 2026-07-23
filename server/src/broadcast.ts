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
import { callHaService, isSupervised, probeService, getEntityState, getAllStates } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';
import { renderAnnouncement, pruneRenderCache, END_OF_MESSAGE_PHRASE, END_OF_MESSAGE_GAP_MS, type AnnouncementLevel } from './audioRenderer.js';
import { resolveChime } from './chimeConfig.js';
import { buildAlertMessage, buildAlertMessageEs, priorityAnnouncementPrefixEs } from './ttsService.js';
import { getBroadcastRuntimeConfig, onBroadcastRuntimeConfigChange } from './broadcastRuntimeConfig.js';
import { setBroadcastHealth } from './broadcastHealth.js';
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
  /** v1.25.0 — SIP / announce-only media_player targets (e.g. the Switchboard
   *  cordless) driven via media_player.play_media(announce) rather than Music
   *  Assistant. MA can't drive a SIP phone (no playback state; volume_set 500s),
   *  so these take the same rendered audio over play_media, dispatched
   *  independently of (and in parallel with) the MA speakers. */
  sipTargets: string[];
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
  // v1.25.0 — SIP / announce-only targets, same parse/validation as `targets`.
  // A target listed in BOTH lists would be double-announced (MA + play_media), so
  // SIP entries also present in `targets` are dropped here — MA wins.
  const sipTargets = (process.env.BROADCAST_SIP_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('media_player.') && !targets.includes(s));
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
    sipTargets,
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
      !a.id.startsWith('forecast-runtime') &&
      // v0.83.0 — a system-outage is a retrospective EVENT (already over when
      // detected); it must not hold the live audible condition yellow for its 24 h
      // visible life. It fires its own one-shot push; excluding it here (like the
      // other event-style ids above) keeps it out of the standing chime/all-clear.
      !a.id.startsWith('system-outage') &&
      // v0.84.0 — the audible-unreachable self-alert MUST push (so it is NOT
      // annunciate:false, which would suppress the push too) but must never
      // raise the audible condition: it would try to chime over the very
      // channel it reports broken, fail, and churn deferred retries. Exclude it
      // by id here — same intent as the system-outage exclusion above.
      !a.id.startsWith('system-audible'),
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

/**
 * v0.87.0 — boot phantom-critical grace. During the post-boot warm-up window,
 * telemetry populates over the first ticks and a transient per-device critical can
 * appear on ONE 10s tick then clear as real values arrive. Because a RED is
 * (correctly) never suppressed by isRestartContinuation, that phantom would
 * annunciate a FALSE emergency ~30s after every restart (observed live 2026-07-06:
 * "condition transition → red (new crit)" ~30s post-boot, critical_alerts=0 after).
 *
 * This returns true (HOLD — do not broadcast this red yet) for the FIRST fresh red
 * within the warm-up window; the caller sets its seen-latch and does NOT advance
 * prevLevel, so a red that PERSISTS re-presents as a transition next tick and then
 * fires (≤ one 10s tick late). A one-tick populate phantom clears and is never
 * spoken. Outside the window, or once the latch is set (confirmed), returns false =
 * fire immediately. A genuine standing critical is therefore delayed by at most one
 * tick and NEVER suppressed. Pure + exported for tests.
 */
export function holdBootRed(
  wouldFireRed: boolean,
  msSinceBoot: number,
  alreadySeen: boolean,
  windowMs = BROADCAST_BOOT_WARMUP_MS,
): boolean {
  return wouldFireRed && msSinceBoot < windowMs && !alreadySeen;
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
  /** v0.84.0 — audible-delivery health. `reachable`: true / false(confirmed) /
   *  null(unprobed or N/A). `usableTargets`: configured speakers currently not
   *  `unavailable`. `reason`: why it's unreachable. Feeds the operator self-alert
   *  (system-audible-unreachable) + the HA diagnostic sensors. */
  audibleReachable: boolean | null;
  audibleUsableTargets: number;
  audibleReason: string | null;
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
  // v1.32.0 (cross-model review) — track whether the LAST SIP dispatch actually
  // DELIVERED (ok > 0), not merely that it was attempted. v1.25.0's skipSip
  // conflated "dispatched" with "delivered": a failed first SIP dispatch was
  // never retried, defeating the alternate channel in exactly the correlated-
  // failure scenario it exists for. Deferred MA retries now skip SIP only when
  // the first dispatch genuinely reached a target. Starts true so a retry armed
  // before any SIP dispatch this boot doesn't replay. Set pessimistically false
  // at dispatch and flipped by the async outcome (~3-5 s, well inside the 30 s
  // first retry delay); if the outcome is somehow still unknown at retry time,
  // we re-fire SIP — for an ALARM channel a rare duplicate beats silence.
  let lastSipDispatchOk = true;
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
      // v1.25.0 — skipSip: this retry exists to reach the MA targets that were
      // unavailable; the SIP target already received this exact audio on the first
      // dispatch, so re-firing it would replay the identical alarm on the cordless.
      // v1.32.0 — but ONLY skip when the first SIP dispatch actually DELIVERED
      // (lastSipDispatchOk); a failed SIP dispatch is retried alongside MA.
      void runBroadcast(level, message, false, messageEs, lastSipDispatchOk);
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
    log(`broadcast: enabled, ${cfg.targets.length} MA target(s): ${cfg.targets.join(', ')}`
      + (cfg.sipTargets.length ? ` + ${cfg.sipTargets.length} SIP target(s): ${cfg.sipTargets.join(', ')}` : ''));
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

  // v0.84.0 — Audible-delivery health probe. Runs on its own throttle (NOT only
  // when a broadcast fires) so a dead audible channel is caught even while the
  // fleet is green. Reachability keys off TARGET AVAILABILITY — the unambiguous
  // signal: when Music Assistant is down, its provided media_players go
  // `unavailable` (or vanish), so usableTargets → 0. That is exactly the silent
  // failure this release exists to surface. A confirm-streak debounces transient
  // HA/MA restart windows (targets briefly deregister) so a blip never fires the
  // operator alert; `reachable` stays null until CONFIRMED, and null never alarms.
  // Invariant/edge: the MOTIVATING failure (MA setup_error) drops ALL players to
  // `unavailable` and HOLDS, so 3-consecutive is reliable. Only a pathologically
  // flapping MA aligned to the probe beat could evade the streak — an unlikely,
  // self-resolving nuisance, not a hidden dead channel.
  const AUDIBLE_HEALTH_PROBE_MS = Number(process.env.BROADCAST_HEALTH_PROBE_MS) || 60_000;
  const AUDIBLE_UNREACHABLE_CONFIRM = Math.max(1, Number(process.env.BROADCAST_UNREACHABLE_CONFIRM ?? 3));
  let lastAudibleHealthAt = 0;
  let audibleReachable: boolean | null = null; // published, debounced
  let audibleUsableTargets = 0;
  let audibleReason: string | null = null;
  let unreachableStreak = 0;
  // Re-entrancy guard: the zero-target broadcast path fires computeAudibleHealth(
  // true) fire-and-forget, which can overlap the periodic interval (or a second
  // failed broadcast) while the prior call is parked on the getEntityState await.
  // Two overlapping runs would each `unreachableStreak += 1` for ONE real probe
  // window and trip CONFIRM early — defeating the very debounce meant to ride out
  // a restart flap. Coalesce: a concurrent call just no-ops (force callers only
  // want to freshen, which the in-flight probe already does).
  let audibleProbeInFlight = false;
  const computeAudibleHealth = async (force = false): Promise<void> => {
    const nowMs = Date.now();
    if (!force && nowMs - lastAudibleHealthAt < AUDIBLE_HEALTH_PROBE_MS) return;
    if (audibleProbeInFlight) return;
    audibleProbeInFlight = true;
    lastAudibleHealthAt = nowMs;
    try {
      const publish = () => setBroadcastHealth({
        enabled: cfg.enabled,
        supervised,
        targetCount: cfg.targets.length,
        usableTargets: audibleUsableTargets,
        // Honest MA flag: the announce service can be REGISTERED yet play to no one
        // (MA in setup_error keeps its services in the catalog) — require a
        // reachable speaker too. Falls back to the raw service probe when unprobed.
        musicAssistantAvailable: musicAssistantAvailable && audibleReachable !== false,
        reachable: audibleReachable,
        reason: audibleReason,
        lastProbeAt: nowMs,
      });
      // Audible not applicable (disabled or unsupervised) → unknown, never alarms.
      if (!supervised || !cfg.enabled) {
        unreachableStreak = 0; audibleReachable = null; audibleUsableTargets = 0; audibleReason = null;
        publish();
        return;
      }
      // Enabled but no speakers configured → a persistent config error, report it
      // immediately (not a transient restart, so no debounce needed).
      if (cfg.targets.length === 0) {
        unreachableStreak = AUDIBLE_UNREACHABLE_CONFIRM; audibleReachable = false; audibleUsableTargets = 0;
        audibleReason = 'no speakers configured (BROADCAST_TARGETS empty)';
        publish();
        return;
      }
      const states = await Promise.all(cfg.targets.map((t) => getEntityState(t).catch(() => null)));
      const usable = states.filter((s) => s != null && s.state !== 'unavailable').length;
      // Two distinct not-usable signatures, worth distinguishing for triage:
      //   • entity present but state==='unavailable' → the integration is loaded
      //     and the speaker/player itself is offline;
      //   • getEntityState returns null → the entity is NOT FOUND (or the read
      //     errored). In THIS deployment the dominant null cause is Music Assistant
      //     in setup_error, which REMOVES its media_players entirely (verified live
      //     at v0.84.0 deploy) — it does NOT leave them at state='unavailable'. A
      //     genuine HA/Supervisor-API outage also yields all-null, so the reason
      //     names BOTH causes without over-committing (a true API outage would also
      //     break this add-on's other reads and the push channel, making MA-down
      //     the likelier cause of an isolated all-null speaker probe).
      const anyReadable = states.some((s) => s != null);
      audibleUsableTargets = usable;
      if (usable > 0) {
        unreachableStreak = 0; audibleReachable = true; audibleReason = null;
      } else {
        unreachableStreak += 1;
        audibleReason = !anyReadable
          ? 'configured speaker(s) not found in Home Assistant — Music Assistant is likely down (its media_players disappear in setup_error), or the HA API is unreachable'
          : `all ${cfg.targets.length} configured speaker(s) report unavailable (Music Assistant or the speakers may be down)`;
        // Only CONFIRM after the streak clears the debounce; until then hold the
        // prior published value (null at boot) so a single restart blip is silent.
        if (unreachableStreak >= AUDIBLE_UNREACHABLE_CONFIRM) audibleReachable = false;
      }
      publish();
    } finally {
      audibleProbeInFlight = false;
    }
  };
  // Seed once shortly after boot (HA registry warm), then on the recurring probe.
  // A probe throw must LOG, never vanish as an unhandled rejection — silent
  // failure is the exact class this module exists to catch, and the try/finally
  // in computeAudibleHealth propagates (doesn't swallow) a throw. Mirror the main
  // tick's `.catch(log)` on every call site.
  const onProbeError = (e: any) => log(`broadcast: audible-health probe failed — ${e?.message ?? e}`);
  const audibleHealthKick = setTimeout(() => { computeAudibleHealth(true).catch(onProbeError); }, 15_000);
  audibleHealthKick.unref();

  // v0.92.0 — CONFIG-DRIFT resolver. A renamed HA entity leaves a stale id in
  // BROADCAST_TARGETS that stays "configured" until the operator notices; the
  // audit found 8 alarm broadcasts (incl. a RED) silently dropped this way when
  // the ecobee ids were renamed. The recurring health probe can't tell a rename
  // (never self-heals) from a transient MA-down (all-null looks the same), so it
  // debounces both. This one-shot resolves every configured target against the
  // FULL HA registry once (registry warm) and, ONLY when other media_player
  // entities exist but the specific target does not — the unambiguous rename
  // signature — logs a loud, named WARN so the operator sees exactly which id
  // drifted. Safe: fires nothing when HA is unreachable (all-null) or MA is fully
  // down (no media_players at all); those stay the health probe's job.
  const resolveTargetDriftOnce = async (): Promise<void> => {
    if (!supervised || !cfg.enabled || cfg.targets.length === 0) return;
    const all = await getAllStates().catch(() => null);
    if (!all) return; // HA API unreachable → not a drift signal, skip
    const present = new Set(all.map((e) => e.entity_id));
    const mediaPlayerCount = all.filter((e) => e.entity_id.startsWith('media_player.')).length;
    const missing = cfg.targets.filter((t) => !present.has(t));
    if (missing.length === 0) return;
    if (mediaPlayerCount === 0) {
      // No media_players at all → Music Assistant likely down; the health probe
      // handles this (debounced), don't cry rename.
      log(`broadcast: ${missing.length} configured target(s) not found and NO media_player entities exist — Music Assistant likely down (health probe will track)`);
      return;
    }
    log(
      `broadcast: WARNING — configured target(s) NOT FOUND in Home Assistant: ${missing.join(', ')}. ` +
      `${mediaPlayerCount} other media_player entities exist, so these ids are almost certainly renamed/mistyped — ` +
      `audible alarms to them will NOT play. Fix BROADCAST_TARGETS.`,
    );
    // Surface it to the operator health tile immediately (un-debounced): a rename
    // never self-heals, so waiting on the streak just delays the signal.
    if (missing.length === cfg.targets.length) {
      unreachableStreak = AUDIBLE_UNREACHABLE_CONFIRM;
      audibleReachable = false;
      audibleReason = `configured speaker id(s) not found in Home Assistant (renamed/mistyped): ${missing.join(', ')}`;
    }
  };
  const targetDriftKick = setTimeout(() => { void resolveTargetDriftOnce().catch(onProbeError); }, 16_000);
  targetDriftKick.unref();
  const audibleHealthInterval = setInterval(() => { computeAudibleHealth().catch(onProbeError); }, AUDIBLE_HEALTH_PROBE_MS);
  audibleHealthInterval.unref();

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
      // v1.24.0 (system audit) — pin PER TARGET, not as one batched volume_set over
      // cfg.targets. HA resolves a batched entity_id list before executing, so a
      // single VOLUME_SET-INCAPABLE target (the cordless_speaker's supported_features
      // lack the bit; the two ecobees have it) makes the whole call raise
      // ServiceNotSupported and NO speaker — including both working ecobees — gets
      // pinned, silently defeating the very loudness safety net this pin exists for
      // (an ecobee AirPlay receiver can drift to ~0.2). Per-target isolates the
      // incapable one so the capable speakers are always set. Best-effort, parallel,
      // still never blocks the announcement.
      const vrs = await Promise.all(cfg.targets.map((t) =>
        callHaService('media_player', 'volume_set', { entity_id: t, volume_level: standingLevel })));
      const failed = cfg.targets.filter((_t, i) => !vrs[i].ok);
      if (failed.length) {
        const firstErr = vrs.find((r) => !r.ok);
        log(`broadcast: pre-announce volume_set to ${standingLevel} failed for ${failed.join(', ')} (continuing) — ${firstErr?.error ?? firstErr?.status}`);
      }
      if (vrs.some((r) => r.ok)) await new Promise((res) => setTimeout(res, 300)); // let RAOP apply before the stream
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
   * v1.25.0 — deliver the announcement to the SIP / announce-only targets (the
   * Switchboard cordless) via media_player.play_media(announce=true). These are NOT
   * Music Assistant players: MA can't drive a SIP phone (no playback state, and a
   * volume_set on the cordless 500s — it has no volume feature), so they take the
   * SAME rendered-audio URL over play_media directly. No volume pre-pin (nothing to
   * pin). Best-effort + parallel: each target is independent, a failure is logged,
   * and — because the caller dispatches this fire-and-forget — it NEVER delays or
   * fails the Music Assistant broadcast. Returns per-target tallies for the log.
   */
  const playSipAnnounce = async (url: string): Promise<{ attempted: number; ok: number; errors: string[] }> => {
    if (cfg.sipTargets.length === 0) return { attempted: 0, ok: 0, errors: [] };
    const results = await Promise.all(cfg.sipTargets.map((t) =>
      callHaService('media_player', 'play_media', {
        entity_id: t,
        media_content_id: url,
        media_content_type: 'music',
        announce: true,
      })));
    const okCount = results.filter((r) => r.ok).length;
    const errs = results
      .map((r, i) => (r.ok ? null : `${cfg.sipTargets[i]}: ${r.error ?? r.status}`))
      .filter((x): x is string => x != null);
    if (errs.length) {
      log(`broadcast: SIP play_media failed for ${errs.length}/${cfg.sipTargets.length} target(s) — ${errs[0]}`);
    } else if (okCount) {
      log(`broadcast: SIP announce → ${okCount} target(s) via play_media`);
    }
    return { attempted: cfg.sipTargets.length, ok: okCount, errors: errs };
  };

  /**
   * Single broadcast: render → one MA call. No staggering, no settles.
   */
  const runBroadcastInner = async (
    level: ConditionLevel,
    message: string | null,
    messageEs: string | null,
    bypassStormGate: boolean,
    skipSip = false, // v1.25.0 — true on a deferred MA retry: SIP already got the first dispatch.
  ): Promise<{ ok: boolean; errors: string[] }> => {
    if (!supervised) return { ok: false, errors: ['not supervised'] };
    // v1.25.0 — at least one Music Assistant target is required (SIP targets are an
    // ADD-ON channel, not a standalone one): it keeps the audible-health self-alert +
    // the whole MA outcome/retry machinery keyed on `cfg.targets` and avoids reporting
    // a SIP-only "success" we can't verify (SIP dispatch is fire-and-forget). A SIP
    // list with no MA targets is treated as no targets, matching the option's help text.
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
    // v1.45.0 — NEVER silent on a spoken-render failure. Live 2026-07-23
    // 05:01 MST: the nightly backup's I/O storm stalled both spoken passes and
    // the whole broadcast was skipped — a red condition transition delivered
    // NO audio at all. On failure, fall back to a chime-only render (cached,
    // no Wyoming dependency) so the klaxon still sounds; the tick layer
    // schedules one spoken retry (pendingSpokenRetry) to deliver the speech
    // once the stall passes. The failed render stays in lastRender/errors so
    // the outcome reports partial and the tts-render-degraded counter is
    // untouched by the chime-only fallback (it only resets on a fresh SPOKEN
    // render success).
    let rr = r;
    let spokenDropped = false;
    if (!r.ok || !r.filename) {
      wyomingReachable = false;
      errors.push(`render: ${r.error ?? 'unknown'}`);
      if (message != null) {
        const fb = await renderAnnouncement({
          level,
          message: null,
          klaxonDir: opts.klaxonDir,
          chimePath: chime.path,
          chimeTag: chime.tag,
          cacheDir: opts.cacheDir,
          wyomingHost: cfg.wyomingHost,
          wyomingPort: cfg.wyomingPort,
          leadSilenceMs: cfg.leadSilenceMs,
          announceRepeat: cfg.repeat,
          repeatGapMs: cfg.repeatGapMs,
          chimeGapMs: cfg.chimeGapMs,
          log,
        });
        if (fb.ok && fb.filename) {
          spokenDropped = true;
          rr = fb;
          errors.push('fallback: chime-only (spoken render failed)');
          log(`broadcast: spoken render failed — falling back to chime-only so the ${level} condition still sounds`);
        } else {
          return { ok: false, errors };
        }
      } else {
        return { ok: false, errors };
      }
    }
    if (message && !spokenDropped) wyomingReachable = true; // only "proved" by a TTS render

    // v1.25.0 — the fetch URL for the rendered audio; shared by the SIP side-channel
    // and the Music Assistant path below.
    const url = `${cfg.audioBase}${opts.cacheUrlPath}/${rr.filename}`;

    // v1.25.0 — SIP / announce-only side-channel (the Switchboard cordless), fired
    // HERE — BEFORE the MA-target availability pre-flight — and FIRE-AND-FORGET:
    //   • before the pre-flight, so the cordless is a genuine ALTERNATE alarm channel
    //     that still speaks even when the MA pre-flight defers because the ecobees are
    //     mid-restart / unavailable (the exact failure it exists to cover);
    //   • fire-and-forget, so the ~3-5 s play_media → switchboard render+originate
    //     round-trip NEVER delays the (already 17-34 s) MA announcement to the ecobees.
    // `skipSip` is set on DEFERRED MA RETRIES (scheduleBroadcastRetry): the retry exists
    // only to reach MA targets that were unavailable — the SIP target already got this
    // exact audio on the first dispatch, so re-firing it would replay the identical
    // alarm on the cordless at +30/+90/+180 s. The first-attempt storm gate (above)
    // already suppresses genuine same-message/same-level re-transitions before here.
    // playSipAnnounce logs its own per-target outcome and never throws (callHaService
    // resolves, Promise.all can't reject); the .catch is belt-and-suspenders.
    if (cfg.sipTargets.length > 0 && !skipSip) {
      lastSipDispatchOk = false; // pessimistic until the async outcome lands (v1.32.0)
      void playSipAnnounce(url)
        .then((r) => {
          lastSipDispatchOk = r.ok > 0;
          if (r.ok === 0) log(`broadcast: SIP dispatch reached 0/${r.attempted} targets — a deferred retry will re-fire SIP`);
        })
        .catch((e) => { lastSipDispatchOk = false; log(`broadcast: SIP dispatch failed — ${e?.message ?? e}`); });
    }

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
      // v0.84.0 — a real broadcast that found ZERO reachable speakers is strong
      // evidence the audible channel is down; freshen the health probe now so the
      // operator self-alert doesn't wait for the next periodic tick to confirm.
      computeAudibleHealth(true).catch(onProbeError);
      log(`broadcast: ${level} deferred — ${errors[0]}`);
      return { ok: false, errors };
    }

    // 3. Single MA play_announcement to every MA target (the SIP side-channel was
    // already dispatched, fire-and-forget, above).
    const call = await playAnnounce(url);
    if (!call.ok) {
      errors.push(`music_assistant.play_announcement: ${call.error}`);
      scheduleBroadcastRetry(level, message, messageEs, 'play_announcement failed after in-call retries');
    }

    if (message && !spokenDropped) lastSpokenMessage = message;

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
    const renderTag = rr.fromCache ? 'cached' : `rendered+${rr.ttsRenderMs ?? 0}ms`;
    if (errors.length === 0) {
      log(`broadcast: ${level} → ok in ${dt}ms (${cfg.targets.length} MA${cfg.sipTargets.length ? ` + ${cfg.sipTargets.length} SIP` : ''} target(s), ${renderTag}, ${rr.sizeBytes ?? '?'} bytes${message ? ', +tts' : ''})`);
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
  // v1.45.0 — one spoken retry after a render-failed condition broadcast. The
  // failure class this covers is a transient host stall (the nightly backup's
  // docker exports saturate the Pi ~04:58-05:02 MST, colliding with quiet-hours
  // end at 05:00): the chime-only fallback already sounded, and the speech is
  // re-attempted once after the stall window. A single retry only — a second
  // consecutive render failure is the tts-render-degraded alert's job, not a
  // retry loop's.
  const SPOKEN_RETRY_DELAY_MS = 90_000;
  let pendingSpokenRetry: { level: ConditionLevel; failedAt: number } | null = null;

  let broadcastChain: Promise<unknown> = Promise.resolve();
  const runBroadcast = (
    level: ConditionLevel,
    message: string | null,
    bypassStormGate = false,
    messageEs: string | null = null,
    skipSip = false, // v1.25.0 — forwarded to runBroadcastInner; set by deferred MA retries.
  ): Promise<{ ok: boolean; errors: string[] }> => {
    const run = () => runBroadcastInner(level, message, messageEs, bypassStormGate, skipSip);
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
  // v0.87.0 — boot phantom-critical grace latch (see holdBootRed). Set once a fresh
  // red is held for confirmation within the warm-up window; cleared whenever the
  // level is not red, so a later red re-confirms rather than fast-tracks.
  let warmupRedSeen = false;
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
    // v1.45.0 — due spoken retry (see pendingSpokenRetry). Runs only when no
    // transition work is in flight; re-checks that the condition level is
    // unchanged (a new transition supersedes the retry naturally), that
    // broadcasts are still enabled, and quiet hours — the same gate the
    // original attempt faced. Bypasses the storm gate: an intentionally
    // identical message is the whole point of the retry.
    if (pendingSpokenRetry && !tickInFlight && Date.now() - pendingSpokenRetry.failedAt >= SPOKEN_RETRY_DELAY_MS) {
      const want = pendingSpokenRetry.level;
      pendingSpokenRetry = null;
      if (level === want && cfg.enabled && !(inQuiet() && !(level === 'red' && cfg.criticalBreakThrough))) {
        tickInFlight = true;
        try {
          log(`broadcast: spoken retry after render failure → ${level}`);
          const message = messageFor(level, alerts);
          const messageEs = messageEsFor(level, alerts);
          const result = await runBroadcast(level, message, true, messageEs);
          lastBroadcastAt = Date.now();
          lastLevel = level;
          lastOutcome = result.ok ? 'success' : 'partial';
          lastErrors = result.errors;
        } finally {
          tickInFlight = false;
        }
        return;
      }
      log(`broadcast: spoken retry dropped — level moved ${want} → ${level} or gated`);
    }
    const transitioned = level !== prevLevel;
    const newCrit = level === 'red' && crit > prevCrit;
    // v0.87.0 — clear the boot phantom-red latch whenever the level is not red
    // (phantom cleared or genuine de-escalation), so a later red in the warm-up
    // window is re-confirmed across a tick rather than fast-tracked.
    if (level !== 'red') warmupRedSeen = false;
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
    // v0.87.0 — boot phantom-critical grace. A fresh red inside the warm-up window
    // is held ONE tick to confirm it is a standing critical and not a
    // telemetry-populate phantom (which appears then clears ~30s post-boot). We do
    // NOT advance prevLevel here, so a persisting red re-presents as a transition on
    // the next 10s tick and fires then; a one-tick phantom clears and is never
    // spoken. Outside the window (or once confirmed) holdBootRed returns false and
    // red fires immediately — never suppressed, delayed by ≤ one tick.
    if (holdBootRed(level === 'red' && (transitioned || newCrit), Date.now() - bootMs, warmupRedSeen)) {
      warmupRedSeen = true;
      log(`broadcast: red held one tick for boot confirmation (warm-up phantom guard)`);
      return;
    }
    // v0.97.0 (re-audit #2) — check in-flight BEFORE committing prevLevel/prevCrit.
    // MA play_announcement blocks 20-105 s (>> the 10 s tick). If a DIFFERENT level
    // arrives while a broadcast is in flight and we advance prevLevel first, the
    // transition reads as already-seen once the broadcast completes and is LOST
    // forever — no retry path recovers it (observed: yellow in flight, green arrives,
    // green never speaks). Returning here WITHOUT advancing prevLevel lets the missed
    // transition re-present as a fresh transition on the next tick once the in-flight
    // broadcast finishes — mirroring the holdBootRed one-tick-hold above. Every OTHER
    // skip below (disabled/minSeverity/quiet) still adopts the level: no retry wanted.
    if (tickInFlight) {
      log(`broadcast: ${level} skipped — previous broadcast still in flight (re-presents next tick)`);
      return;
    }
    // Snapshot the transition state so a SAME-level re-arrival during the next
    // in-flight window doesn't re-fire (the `transitioned` check above handles it).
    prevLevel = level;
    prevCrit = crit;
    if (!cfg.enabled) return;
    // v1.17.0 (engine-review F14 follow-up) — never SPEAK an all-clear while a
    // critical-severity alert is active, even one excluded from the ambient
    // condition COUNT above. shp2-below-reserve is excluded by design (the
    // grid-aware runwayAlarm owns its audible), but with F14's inclusive floor
    // the at-the-reserve-floor state occupies that id for the whole off-grid
    // dwell — and a spoken "All clear. All stations report normal." while the
    // runway alarm is simultaneously announcing a critical at the floor is a
    // contradiction on the same speakers. The ambient LEVEL still adopts green
    // (v0.23.0 counting design unchanged; state committed above — no retry);
    // only the green ANNOUNCEMENT is gated.
    if (level === 'green' && alerts.some((a) => a.severity === 'critical' && a.annunciate !== false)) {
      log('broadcast: green adopted silently — a critical alert is still active (all-clear speech gated)');
      return;
    }
    if (level === 'yellow' && cfg.minSeverity === 'critical') return;
    // v0.23.0 — yellow/green always respect quiet hours. red (a critical
    // condition) breaks through ONLY when the operator opted in; default OFF ⇒
    // red is also suppressed overnight (the alert stays visible on-screen, and
    // the push path queues it for the morning digest).
    if (inQuiet() && !(level === 'red' && cfg.criticalBreakThrough)) {
      log(`broadcast: ${level} suppressed by quiet hours`);
      return;
    }
    tickInFlight = true;
    try {
      log(`broadcast: condition transition → ${level}${newCrit ? ' (new crit)' : ''}, ${cfg.targets.length} target(s)`);
      pendingSpokenRetry = null; // a fresh transition supersedes any queued retry
      const message = messageFor(level, alerts);
      const messageEs = messageEsFor(level, alerts); // v0.62.0 — Spanish second pass
      const result = await runBroadcast(level, message, false, messageEs);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = result.ok ? 'success' : 'partial';
      lastErrors = result.errors;
      // v1.45.0 — a render failure (chime-only fallback or full skip) earns ONE
      // spoken retry after the stall window.
      if (!result.ok && result.errors.some((e) => e.startsWith('render:'))) {
        pendingSpokenRetry = { level, failedAt: Date.now() };
        log(`broadcast: spoken render failed — one retry scheduled in ${SPOKEN_RETRY_DELAY_MS / 1000}s`);
      }
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
      // v0.84.0 — honest: the announce service can be registered while playing to
      // no one (MA in setup_error). Report it available only when it is present
      // AND audible isn't CONFIRMED unreachable.
      musicAssistantAvailable: musicAssistantAvailable && audibleReachable !== false,
      wyomingReachable,
      testCooldownRemainingMs: Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now()),
      lastSpokenMessage,
      stormSuppressedCount,
      // v0.84.0 — audible-delivery health (feeds the operator self-alert + sensor).
      audibleReachable,
      audibleUsableTargets,
      audibleReason,
      lastRender: { ...lastRender },
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
      clearInterval(pruneInterval);
      clearInterval(audibleHealthInterval);
      clearTimeout(audibleHealthKick);
      offRuntimeConfig();
    },
  };
}
