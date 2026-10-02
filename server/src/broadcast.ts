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
import { VDIFF_KNEE_GAP_CARRY_MS } from './alerts.js';
import { TELEMETRY_BLIND_ALERT_ID } from './telemetryBlind.js';
import { config } from './config.js';
import { callHaService, isSupervised, probeService, getEntityState, getAllStates } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';
import { renderAnnouncement, pruneRenderCache, prewarmTerminatorCache, END_OF_MESSAGE_PHRASE, END_OF_MESSAGE_GAP_MS, type AnnouncementLevel, type RenderOptions } from './audioRenderer.js';
import { resolveChime } from './chimeConfig.js';
import { buildAlertMessage, buildAlertMessageEs, priorityAnnouncementPrefixEs, pickPrimaryAlert } from './ttsService.js';
import { getBroadcastRuntimeConfig, onBroadcastRuntimeConfigChange } from './broadcastRuntimeConfig.js';
import { setBroadcastHealth } from './broadcastHealth.js';

/**
 * v1.166.0 — the all-clear SPEECH gate (v1.17.0), extracted so it can be tested.
 * Never speak "All clear" while a critical is active. A critical muted by POLICY (a
 * bench spare) still does not block it, as before — but the telemetry-blind alert
 * held by the remediate-first gate (blindRemediation.ts) DOES: held is not cleared,
 * and "All clear. All stations report normal." spoken while the system is BLIND is the
 * worst sentence these speakers could say. Found by the v1.166.0 pre-merge review: the
 * hold's annunciate=false made this gate stop seeing the blind alert.
 */
export function allClearSpeechBlocked(
  alerts: ReadonlyArray<Pick<Alert, 'id' | 'severity' | 'annunciate'>>,
): boolean {
  return alerts.some((a) =>
    a.severity === 'critical' && (a.annunciate !== false || a.id === TELEMETRY_BLIND_ALERT_ID));
}
// v0.11.0 — ISA-18.2 / IEC 62682 annunciation gate + per-priority preview.
// A priority turned off on the Alert Settings page must never trigger the
// chime/broadcast, so we filter silenced-priority alerts out before deriving
// the broadcast condition. previewMessageFor() drives the per-priority
// "preview announcement" feature on the settings page.
import {
  type AlarmPriority,
  type AlarmRung,
  priorityOf,
  priorityRank,
  klaxonLevelForPriority,
  previewMessageFor,
  priorityAnnouncementPrefix,
  ALL_CLEAR_PREVIEW_MESSAGE,
} from './alertPriority.js';
import { isPriorityEnabled } from './alertSettings.js';
import { getAlertOnset } from './alertOnset.js';
// v1.64.0 — the identity-aware post-restart RED replay gate. It is a SEPARATE
// module from isRestartContinuation on purpose: that one is level-only and must
// stay that way (see its comment), this one is handed alert FINGERPRINTS.
// LEVEL_RANK/isLevelEscalation live there too so the storm gate below and the
// replay gate's escalation carve-out share ONE rank ladder.
import {
  alertFingerprint,
  clearsRedReplayEvidence,
  createRedReplayGate,
  describeFingerprint,
  isFingerprint,
  isLevelEscalation,
  isRecordableRedAnnounce,
  LEVEL_RANK,
  voicedRedFingerprint,
} from './redReplayGate.js';

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
  // v1.57.0 — volume has exactly ONE source: the BROADCAST_VOLUME add-on option.
  // The live slider and its /data override are gone; two places to set one number
  // meant the HA form could read 0.7 while the speakers played at 0.95, with
  // nothing on either surface saying so.
  const volume = envVolume;
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

/**
 * v1.185.1 — the levels POST /api/broadcast/test accepts, and its default. The route validated
 * against CHIME_LEVELS, which v1.59.0 turned into the five alarm RUNGS (critical…clear): from then
 * on every documented call — `red`, `yellow`, `green`, and the empty body that defaults to `red` —
 * was refused with 400, and a rung name slipped through only to be spoken as "All clear". The test
 * broadcast is a CONDITION-level test (its own "This is only a test." message per level), so it is
 * validated against the condition levels.
 */
export const BROADCAST_TEST_LEVELS: readonly ConditionLevel[] = ['red', 'yellow', 'green'];
export function parseBroadcastTestLevel(raw: unknown): ConditionLevel | null {
  const level = raw ?? 'red';
  return typeof level === 'string' && (BROADCAST_TEST_LEVELS as readonly string[]).includes(level) ? (level as ConditionLevel) : null;
}

export function conditionFromAlerts(
  alerts: Alert[],
): {
  level: ConditionLevel; crit: number; warn: number; rung: AlarmRung; criticalIds: string[]; criticalFingerprints: string[];
  warningFingerprints: string[];
} {
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
      // v1.187.0 — `audible:false` keeps the card and the push but never raises the condition
      // (a peer cell-spread outlier at top of charge; see Alert.audible). The broadcast tick
      // also drops it before messageFor, so it can never be the alert that is voiced.
      a.audible !== false &&
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
      !a.id.startsWith('system-audible') &&
      // v1.173.0 — the message-rate collapse warning is a STALE-DATA alarm, and the owner's
      // rule (2026-09-17) is that a stale-data alarm sounds only after the immediate
      // remediation has failed. It fires at the ONSET of a collapse, ~4 min before the
      // telemetry-blind alarm starts that remediation, so it spoke a yellow on every cloud
      // stale-shadow episode (2026-09-21 18:13, the rebuild then restoring it in ~2 min). It
      // keeps its push and card (annunciate stays unset — annunciate:false would drop the
      // push too); the telemetry-blind CRITICAL remains the audible, remediation-first path.
      !a.id.startsWith('msg-rate-floor-') &&
      // v1.173.0 — and the "Telemetry stale" warning, for the same rule. It spoke a yellow
      // ~20 s after every restart (2026-09-21 18:23:31, five deploys that day: a device reads
      // stale until its first fresh reading lands) and at stale episodes. Push + card kept.
      !a.id.startsWith('stale-') &&
      // v1.187.1 — the panel-soiling estimate is maintenance that moves over weeks, never danger:
      // a push and a card, no chime. What keeps it off the speakers is its `audible: false`
      // (above, and speakableAlerts); this id exclusion is the second guard, as for
      // peak-idle-pool below. 2026-09-30 17:03 it was the only counted warning and spoke a
      // yellow ("Medium priority alarm. Solar system. …") on a curtailment artifact.
      !a.id.startsWith('soiling-pv') &&
      // v1.187.0 — the on-peak idle-pool notice (peakGridDraw.ts) reports spend, never
      // danger: a [Low] push and a card, and no chime. A yellow for money would be spoken
      // in the tier a grid loss uses. (annunciate:false would drop the push too.)
      // v1.187.0 (log review) — a SECOND guard. What keeps the notice off the speakers is its
      // `audible: false` (above, and speakableAlerts): this id exclusion alone kept it out of
      // the count but not out of the spoken message, where it outranked the warning that
      // raised the yellow.
      !a.id.startsWith('peak-idle-pool'),
  );
  const criticals = counted.filter((a) => a.severity === 'critical');
  const crit = criticals.length;
  const warn = counted.filter((a) => a.severity === 'warning').length;
  const level: ConditionLevel = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green';

  // v1.64.0 — the IDENTITY of the criticals behind a red, carried out of this
  // seam because it exists here and nowhere downstream. redReplayGate needs it to
  // tell "the same standing fault, announced minutes ago" from "a new, distinct
  // emergency"; without it the only available discriminator is the LEVEL, and a
  // level-keyed gate would mute a fresh critical behind a stale one. Sorted so the
  // persisted set is order-stable across ticks.
  //
  // ★★★ TWO different things, and they are NOT interchangeable:
  //   criticalIds          — for the LOG LINE and for human diagnostics ONLY.
  //   criticalFingerprints — the gate's identity: id + title + fault.
  // A bare id is the SOURCE, not the FAULT: `dpu-err-<sn>` is emitted for every
  // value of sysErrCode (alerts.ts holds the id constant on purpose), so a
  // standing fault clearing and a DIFFERENT real fault appearing on the same
  // device share one id. NEVER feed criticalIds to redReplayGate — that is the
  // defect this seam exists to prevent. See redReplayGate.alertFingerprint.
  const criticalIds = criticals.map((a) => a.id).sort();
  const criticalFingerprints = criticals.map((a) => alertFingerprint(a)).sort();
  // v1.187.0 — the same identity for the counted WARNINGS. The de-escalation dwell holds a
  // downward move only while nothing NEW to the audible has appeared (newWarn in the tick),
  // and the repeat-warning gate (sameWarningRepeat) never swallows a warning that was not
  // counted when the last yellow was spoken. Fingerprints, not detail text: a warning's detail
  // carries its live reading, which would make every tick look new.
  const warningFingerprints = counted.filter((a) => a.severity === 'warning').map((a) => alertFingerprint(a)).sort();

  // v1.59.0 — the RUNG: the most severe ISA priority among the same counted pool,
  // or `clear` when nothing is raised.
  //
  // ★★★ `clear` keys off crit === 0 && warn === 0 — NOT off `counted` being
  // empty. Info-severity alerts sit in `counted` while moving NEITHER counter
  // (`grid-offgrid` is a standing normal state here), so testing emptiness would
  // make every recovery play the LOW advisory tone instead of the all-clear.
  let rung: AlarmRung = 'clear';
  if (crit > 0 || warn > 0) {
    const raised = counted.filter((a) => a.severity === 'critical' || a.severity === 'warning');
    rung = raised.reduce<AlarmRung>((worst, a) => {
      const p = priorityOf(a);
      return priorityRank(p) < priorityRank(worst as AlarmPriority) ? p : worst;
    }, priorityOf(raised[0]));
  }
  return { level, crit, warn, rung, criticalIds, criticalFingerprints, warningFingerprints };
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
 * SAFETY: a RED (critical) observation is NEVER a continuation HERE — it always
 * returns false and broadcasts. Two reasons: (1) a critical that is still active
 * across a restart SHOULD be re-announced; (2) THIS function sees only levels, so
 * a NEW, distinct critical firing during the warm-up window while a pre-restart
 * red was already active would otherwise be swallowed by a same-rank (red≤red)
 * match — an unacceptable risk of muting a fresh emergency. The restart re-speak
 * bug observed in v0.58.0 was a YELLOW advisory; that is all this suppresses.
 *
 * ★★★ v1.64.0 — reason (2) is why the red re-announce rate limit lives in
 * redReplayGate.ts and NOT in this function. That gate is IDENTITY-aware: it is
 * handed the active critical alert ID SET from conditionFromAlerts, and refuses
 * to suppress unless every active critical id was already in the set that was
 * spoken aloud less than 30 min ago. Do NOT "simplify" it back into a red≤red
 * level match here — that reintroduces exactly the mute described above.
 *
 * Pure + exported for tests.
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
 * v1.187.3 — A GREEN THAT HAS STOOD ITS DWELL ON A SETTLED ALERT SET IS A RECOVERY, NOT A
 * RESTART CONTINUATION.
 *
 * isRestartContinuation files any green at or below the pre-restart baseline as a continuation for
 * the whole warm-up window, so a yellow the household heard before a restart, that then cleared
 * inside the window, was never followed by an all-clear. 2026-10-01 after the 19:20 deploy: the
 * yellow standing at the first tick was adopted as a continuation (19:20:27), the level fell to
 * green (held by the de-escalation dwell from 19:20:47), and when it had stood the dwell
 * (19:23:47) the green "matched the pre-restart advisory" and was adopted in silence. The last
 * words in the house stayed a warning that had cleared.
 *
 * The continuation exists for a level the house already heard, re-presented as a rise by the
 * post-boot warm-up (v0.58.0). A green TRANSITION is never that: the first tick joins a green
 * silently, so a green transition always follows a yellow or red committed since boot — a
 * continuation of the heard yellow/red baseline, or (under a heard green baseline) one committed
 * as a new condition. Its clearing is news. It is a recovery, announced like any transition (the
 * all-clear speech gate, quiet hours and the storm gates still apply), when all three hold:
 *   • a heard baseline exists (conditionBootBaseline returns a level only when it was heard; with
 *     none, isRestartContinuation suppresses nothing anyway);
 *   • the alert set is SETTLED, and has been since `alertSetSettledSinceMs` (the alert monitor's
 *     stamp, alertMonitor.alertSetTrusted): the store hydrated, every worker/NWS feed's delivery
 *     in the published set, the boot onset debounces run, no in-memory onset clock withholding a
 *     fault. A green read from an unpopulated store, before a feed's alerts are in the set, or
 *     while a critical that stood before the restart is still inside its restarted debounce
 *     (dpu-err, shp2-src-err: 3 min) is not an all-clear — the boot false-green;
 *   • v1.187.3 (review) — the green has stood the de-escalation dwell (CONDITION_CLEAR_DWELL_MS)
 *     ON that settled set: measured from the later of greenSinceMs and alertSetSettledSinceMs.
 *     Checking "settled" only at the commit let a green that began on an unsettled set be spoken
 *     seconds before the withheld critical re-published — "All clear", then the klaxon.
 * Until then the tick HOLDS the green (it is not committed; see the de-escalation hold), so it is
 * not adopted as a continuation before the set has had the chance to settle. If the warm-up ends
 * first, it is adopted silently as before v1.187.3 (fail-quiet). A yellow under any baseline is
 * unchanged (yellow → yellow stays a continuation), and RED never reaches here as a continuation
 * (isRestartContinuation). Pure + exported for tests.
 */
export function isRestartRecovery(
  baseline: ConditionLevel | null,
  observed: ConditionLevel,
  greenSinceMs: number | null,
  nowMs: number,
  alertSetSettledSinceMs: number | null,
  dwellMs = CONDITION_CLEAR_DWELL_MS,
): boolean {
  if (observed !== 'green') return false;
  if (baseline == null) return false;
  if (greenSinceMs == null || alertSetSettledSinceMs == null) return false;
  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) >= dwellMs;
}

/**
 * v1.186.0 — WHO asked for a broadcast. One single-flight pipeline carries three kinds, and
 * only one of them describes the house:
 *   condition — a condition transition from the tick (and its deferred/spoken retries);
 *   dedicated — announce(): the SoC ladder, the runway alarm, the night-charge and Charge Now
 *               notices. Real audio, but not the condition (their ids are excluded from it);
 *   test      — POST /api/broadcast/test. "This is only a test."
 * Until v1.186.0 every kind wrote the same bookkeeping: a verified red test armed the
 * same-level storm gate, so a real red inside the next ~2 min was refused with no retry, and
 * the 21:30 night-charge consent notice became the next boot's restart baseline (yellow while
 * the house was green), so a genuine new yellow after that restart was filed as a duplicate.
 */
export type BroadcastKind = 'condition' | 'dedicated' | 'test';

/**
 * v1.186.0 — the restart baseline, from the persisted CONDITION record (never from the
 * last-broadcast summary, which also carries tests and dedicated announcements).
 *
 * The record is written by the tick on EVERY adoption of a condition level — spoken or
 * silent (quiet hours, the all-clear speech gate, a storm-gated transition) — with `spoken`
 * true only once a condition broadcast of that level was VERIFIED delivered, or the level was
 * adopted as a continuation of one heard before a restart. A level the household never heard
 * gives no baseline, so a restart re-speaks it (v0.58.0: "a failed/never-played pre-restart
 * broadcast must still re-fire"). A record without the fields (written before v1.186.0) also
 * gives none: its only level is the contaminated last-broadcast one. Pure + exported for tests.
 */
export function conditionBootBaseline(
  rec: { conditionLevel?: unknown; conditionSpoken?: unknown } | null | undefined,
): ConditionLevel | null {
  if (rec == null) return null;
  const l = rec.conditionLevel;
  if (l !== 'green' && l !== 'yellow' && l !== 'red') return null;
  return rec.conditionSpoken === true ? l : null;
}

/**
 * v1.186.0 — which configured Music Assistant targets can take an announcement right now, and
 * why the others cannot. Usable is exactly the pre-v1.186.0 rule (a state was read and it is not
 * `unavailable`). A null read is NOT usable: it means "not found", or a read that failed — and a
 * read that failed is no evidence the speaker is back. Pure + exported for tests.
 */
export function classifyAudibleTargets(
  targets: readonly string[],
  states: ReadonlyArray<{ state: string } | null | undefined>,
): { usable: string[]; unusable: string[] } {
  const usable: string[] = [];
  const unusable: string[] = [];
  targets.forEach((t, i) => {
    const s = states[i];
    if (s == null) unusable.push(`${t} (not found or unreadable)`);
    else if (s.state === 'unavailable') unusable.push(`${t} (unavailable)`);
    else usable.push(t);
  });
  return { usable, unusable };
}

/**
 * v1.186.0 — the DEGRADED audible channel: fewer usable Music Assistant targets than are
 * configured. The unreachable alarm (v0.84.0) fires only at ZERO usable, so a speaker that went
 * `unavailable` (one of two was dark for ~27 h on 2026-09-23/24) raised nothing while every
 * broadcast logged "2 MA … → ok". Same debounce style as the unreachable streak — `confirm`
 * consecutive short probes before it is raised, so a restart blip is silent — and it clears on
 * the first probe that reads every target usable (a failed read never counts as usable, so
 * absence cannot clear it). Zero usable counts too, so the degraded alert stands while the
 * unreachable streak builds; the alert builder hands over to the unreachable alert once that is
 * confirmed. Pure + exported for tests.
 */
export function audibleDegradedStep(
  prevStreak: number,
  configured: number,
  usable: number,
  confirm: number,
): { streak: number; degraded: boolean } {
  if (configured === 0 || usable >= configured) return { streak: 0, degraded: false };
  const streak = prevStreak + 1;
  return { streak, degraded: streak >= confirm };
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
/**
 * v1.173.1 — boot YELLOW confirmation. After a restart several warnings are transiently
 * wrong for a minute or two: an off-panel Core's standing warnings are muted only once its
 * off-panel streak rebuilds (it restarts at zero), a device reads stale until its first
 * fresh reading, learned alerts re-warm. isRestartContinuation only suppresses a yellow at
 * or below the pre-restart level, so each of the five restarts on 2026-09-21 spoke a fresh
 * yellow ~20-60 s after boot (18:23:31, 19:04:09 — Core 3's forecast-imbalance before its
 * off-panel mute). Inside the warm-up window a fresh yellow must now PERSIST for
 * BOOT_YELLOW_CONFIRM_MS before it is spoken; a genuine standing warning is delayed by at
 * most that. RED is untouched (holdBootRed, one tick). Pure + exported for tests.
 */
/**
 * v1.174.0 — CELL-IMBALANCE SPEAK HOLD. A cell-voltage spread warning is a slow, physical
 * condition, and its threshold sits close enough to normal working spread that packs cross
 * it for a few minutes and settle back: on 2026-09-21 a 6-minute excursion at 21:14 spoke a
 * yellow over the house, and the overnight record is full of 2-30 minute episodes. Nothing
 * about the first minute of an imbalance is actionable — the operator cannot act faster
 * than the pack rebalances — so the audible now waits until the spread has STOOD.
 *
 * ★ Scope, deliberately narrow (a guard in this shared chokepoint feeds BOTH the condition
 * level and the spoken message): warnings only, and only the two ids that describe the same
 * cell-spread event. The CRITICAL (`vdiff-crit-`) is untouched and still speaks at once.
 * The card and the push are untouched — this filter exists only on the audible path.
 *
 * Age comes from the restart-persistent onset sidecar, so a hold survives a restart rather
 * than resetting the clock (this host restarts roughly daily, and a 10-minute hold that
 * restarts with the process would never expire). An UNKNOWN onset holds: alertMonitor
 * stamps every active id once per 20 s tick, so the unknown state is bounded to one tick —
 * and an id whose onset was never recorded is, by that same sync, one that has only just
 * appeared.
 */
export const IMBALANCE_SPEAK_HOLD_MS = 10 * 60_000;
/** The id prefixes the hold applies to — one physical event, reported twice (the pack's own
 *  spread, and the same pack as a peer outlier; both fired within 40 s at 21:14). */
export const IMBALANCE_SPEAK_HOLD_PREFIXES = ['vdiff-warn-', 'peer-voldiff-'] as const;
export function heldForImbalanceConfirm(
  alert: Pick<Alert, 'id' | 'severity'>,
  nowMs: number,
  onsetMs: number | undefined,
  holdMs = IMBALANCE_SPEAK_HOLD_MS,
): boolean {
  if (alert.severity !== 'warning') return false;
  if (!IMBALANCE_SPEAK_HOLD_PREFIXES.some((prefix) => alert.id.startsWith(prefix))) return false;
  if (onsetMs == null) return true;
  return nowMs - onsetMs < holdMs;
}

/**
 * v1.187.0 — the broadcast tick's pre-filter: the ONE array that feeds both conditionFromAlerts
 * (the level) and messageFor (the words), so nothing it drops can raise the condition or be the
 * alert that is voiced when something else raises it. In order:
 *  - a priority silenced on the Alert Settings page (v0.11.0);
 *  - `audible:false` (v1.187.0 — a peer cell-spread outlier at top of charge, or while its pack's
 *    vdiff-crit is held by a bounded cell-spread mute; card and push kept);
 *  - a cell-imbalance warning still inside its speak hold (heldForImbalanceConfirm, v1.174.0).
 * `onsetOf` is the restart-persistent onset lookup (alertOnset.getAlertOnset in production).
 */
export function speakableAlerts(
  alerts: readonly Alert[],
  nowMs: number,
  onsetOf: (id: string) => number | undefined,
): Alert[] {
  return alerts
    .filter((a) => isPriorityEnabled(priorityOf(a)))
    .filter((a) => a.audible !== false)
    .filter((a) => !heldForImbalanceConfirm(a, nowMs, onsetOf(a.id)));
}

export const BOOT_YELLOW_CONFIRM_MS = 2 * 60_000;
export function holdBootYellow(
  wouldFireYellow: boolean,
  msSinceBoot: number,
  yellowSinceMs: number | null,
  nowMs: number,
  windowMs = BROADCAST_BOOT_WARMUP_MS,
): boolean {
  if (!wouldFireYellow || msSinceBoot >= windowMs) return false;
  return yellowSinceMs == null || nowMs - yellowSinceMs < BOOT_YELLOW_CONFIRM_MS;
}

export function holdBootRed(
  wouldFireRed: boolean,
  msSinceBoot: number,
  alreadySeen: boolean,
  windowMs = BROADCAST_BOOT_WARMUP_MS,
): boolean {
  return wouldFireRed && msSinceBoot < windowMs && !alreadySeen;
}

/**
 * v1.187.0 — CONDITION DE-ESCALATION DWELL. The audible condition had no hysteresis on the way
 * DOWN: it is re-derived from the warning count on every tick, so a warning that flips
 * warning↔info as sibling readings land flipped the condition yellow↔green, and a green is a
 * spoken "All clear". On 2026-09-29 one peer-voldiff episode (Core 1 pack 1, a single tracked
 * episode 15:06-15:44) went green-then-yellow three times in ten minutes, and "All clear. All
 * stations report normal." was spoken at 15:20:51 while that pack's spread was 58 mV and
 * rising and its push card was still open; it went critical 18 min later. The z-score dipped
 * only because a sibling's staggered ~3-min reading moved the median and MAD — noise, not a
 * recovery.
 *
 * A move to a LOWER level now commits only once the condition has stood at or below it for
 * CONDITION_CLEAR_DWELL_MS — the same 3 minutes the push path holds a cell-imbalance
 * "Resolved:" (VDIFF_RESOLVE_DWELL_MS). Until then the tick does not advance prevLevel, so a
 * flicker back up is no transition and nothing is spoken either way:
 *   • green commits once GREEN has held the dwell (from yellow or from red) — a yellow↔green
 *     flicker below a cleared red never speaks an all-clear;
 *   • yellow commits (from red) once the level has been below red for the dwell.
 * Only good news waits. A rise never does, and neither does anything NEW to the audible: a
 * critical or warning whose fingerprint was not counted when the standing level was committed
 * commits and speaks at once (newCrit / newWarn in the tick) — so a DIFFERENT critical that
 * replaces the cleared one at the same count is announced, which a count alone cannot see.
 * Pure + exported for tests.
 */
export const CONDITION_CLEAR_DWELL_MS = 3 * 60_000;
export function deescalationDue(
  observed: ConditionLevel,
  belowRedSinceMs: number | null,
  greenSinceMs: number | null,
  nowMs: number,
  dwellMs = CONDITION_CLEAR_DWELL_MS,
): boolean {
  if (observed === 'green') return greenSinceMs != null && nowMs - greenSinceMs >= dwellMs;
  if (observed === 'yellow') return belowRedSinceMs != null && nowMs - belowRedSinceMs >= dwellMs;
  return true; // red is never a de-escalation
}

/** v1.187.0 — does `current` carry an alert identity (fingerprint) that `known` — recorded when
 *  the standing level was committed — does not? Pure + exported for tests. */
export function hasNewIdentity(current: readonly string[], known: ReadonlySet<string>): boolean {
  return current.some((f) => !known.has(f));
}

/**
 * v1.187.0 (log review) — how long a CELL-SPREAD critical that sounded is still held after it was
 * last present. The BMS publishes cell voltages about every 180 s and the monitor publishes on a
 * 20 s grid, so a spread that follows the charge current (95 / 45 mV on alternate readings) is
 * absent for 180-200 s between two loud readings — as long as CONDITION_CLEAR_DWELL_MS — and one
 * missed reading makes that 360 s. Two reading periods plus a monitor tick (380 s), rounded up.
 */
export const SOUNDED_VDIFF_ABSENT_HOLD_MS = 7 * 60_000;

/**
 * v1.187.0 (log review) — A CRITICAL THAT SOUNDED AND IS THEN HELD BY A BOUNDED CELL-SPREAD MUTE IS
 * HELD, NOT CLEARED. A vdiff-crit that annunciated (the red klaxon, a [Critical] push) can be muted
 * again on a later reading — the BMS resumes balancing below 95% SoC, where the balancing mute
 * applies for up to 20 minutes from the first crossing — and then it no longer counts: the level
 * reads green (its peer outlier is quieted with it), the de-escalation dwell committed that green
 * after 3 minutes, and allClearSpeechBlocked, which reads `annunciate`, let "All clear. All
 * stations report normal." be spoken with the critical's card open — between two klaxons for the
 * same pack when the mute lapsed. While this returns true the tick treats the observation as red
 * for the dwell clocks, so no move below red (nor yellow → green) commits: the hold lasts until
 * that critical clears — then the lower level stands its own full dwell and the all-clear is
 * spoken — or annunciates again, a flicker the hold absorbs (nothing is re-spoken).
 *
 * BETWEEN READINGS a cell-spread critical is not cleared either. One that follows the charge
 * current is absent on alternate BMS readings (95 / 45 mV every ~180 s): absent for as long as the
 * dwell, it let green commit and the all-clear be spoken between two klaxons for the same pack. A
 * sounded `vdiff-crit-` that is ABSENT therefore also holds, until it has been gone
 * SOUNDED_VDIFF_ABSENT_HOLD_MS; a genuine clear gets its all-clear that long plus the dwell after
 * it. Any other critical is released the tick it clears, as before.
 *
 * `sounded` maps the fingerprints of the criticals counted at a committed red (adoptLevel, and each
 * tick the committed level stays red — so one that returned inside a hold, which commits nothing,
 * is still recorded) to the last tick each was present; it is refreshed here while present. A
 * cleared critical is PRUNED once released, so one that returns muted, never having sounded in its
 * new episode, holds nothing (as before: a muted critical that never sounded does not block the
 * all-clear). Only the typed bounded mute (`mutedBy`) holds a PRESENT critical — never a policy
 * mute (a bench spare, an off-panel Core), which does not end with the condition. MUTATES
 * `sounded`; pure otherwise. Exported for tests.
 * v1.187.1 — a policy stamp that takes precedence over a bounded mute now CLEARS `mutedBy` (the
 * bench-spare stamp in alerts.ts, applyRosterMute in alertMonitor.ts): both used to overwrite
 * `annunciate` / `muteReason` and leave it set, so a sounded vdiff-crit muted by policy that also
 * carried a knee mute held the level red and delayed the all-clear. `muteReason` stays diagnostic
 * only (test/muteReasonLog): this reads `mutedBy`, which names the mute in force.
 */
export function soundedCriticalHeld(
  alerts: ReadonlyArray<Pick<Alert, 'id' | 'title' | 'fault' | 'severity' | 'mutedBy'>>,
  sounded: Map<string, number>,
  nowMs: number,
  absentHoldMs = SOUNDED_VDIFF_ABSENT_HOLD_MS,
): boolean {
  const present = new Set(alerts.filter((a) => a.severity === 'critical').map((a) => alertFingerprint(a)));
  let betweenReadings = false;
  for (const [f, lastPresentMs] of [...sounded]) {
    if (present.has(f)) sounded.set(f, nowMs);
    else if (f.startsWith('vdiff-crit-') && nowMs - lastPresentMs < absentHoldMs) betweenReadings = true;
    else sounded.delete(f);
  }
  return betweenReadings || alerts.some((a) => a.severity === 'critical' && a.mutedBy != null && sounded.has(alertFingerprint(a)));
}

/**
 * v1.187.3 (log review) — the oldest last-present time of a sounded critical that is restored at
 * boot (restoreSoundedCriticals): VDIFF_KNEE_GAP_CARRY_MS, the longest outage a persisted knee
 * session survives (restoreVdiffKneeSessions). After a longer outage the knee mute starts a new
 * session, and its critical is a new episode that has not sounded.
 */
export const SOUNDED_CRIT_RESTORE_MAX_AGE_MS = VDIFF_KNEE_GAP_CARRY_MS;

/** v1.187.3 (log review) — while the sounded record holds anything it is rewritten at most this
 *  often, so a last-present time on disk is at most this stale when the age bound reads it. */
export const SOUNDED_CRIT_PERSIST_EVERY_MS = 60_000;

/**
 * v1.187.3 (log review, LOW) — the sounded criticals the status file keeps and restores: the
 * cell-spread criticals (`vdiff-crit-`), the only ones that can hold anything after a restart.
 * soundedCriticalHeld holds a PRESENT critical only while its bounded mute is in force (`mutedBy`,
 * which only a vdiff-crit carries: Alert.mutedBy is a VdiffCritMuteReason) and an ABSENT one only
 * when it is a `vdiff-crit-`; any other critical never holds while present and is released the
 * tick it clears. Persisted, the others only rewrote the status file on every fault-code flip of a
 * standing critical (the absent code pruned, the present one recorded) and every minute while one
 * stood. In memory the record still keeps every critical that sounded. Pure + exported for tests.
 */
export function soundedCritPersists(fingerprint: string): boolean {
  return fingerprint.startsWith('vdiff-crit-');
}

/**
 * v1.187.3 (log review) — THE SOUNDED RECORD SURVIVES A RESTART. soundedCriticalHeld reads
 * `soundedCritFps`, which lived only in memory: after a restart a cell-spread critical that had
 * sounded read as one that never had. A vdiff-crit muted again by its knee mute after the restart,
 * or absent between two BMS readings, then held nothing; a warning standing at the first tick was
 * adopted as a continuation of the heard red, it cleared, and the green that followed was announced
 * as a recovery (isRestartRecovery): "All clear" with the critical's card open, then the klaxon
 * when the mute lapsed. allClearSpeechBlocked reads `annunciate`, so it let the speech through.
 *
 * The record is written to the broadcast status file (`soundedCrit`: fingerprint → last-present
 * ms) whenever its set changes, and at most every SOUNDED_CRIT_PERSIST_EVERY_MS while it holds
 * anything. At boot this restores each entry whose fingerprint is well formed and whose
 * last-present time is finite and at most `maxAgeMs` before `bootMs`, stamped `bootMs`: nothing
 * was observed during the outage, so it is not counted as absence (an absent cell-spread critical
 * is then held SOUNDED_VDIFF_ABSENT_HOLD_MS from the boot). Whatever the condition record says:
 * only a committed red writes an entry and the record prunes itself, and the hold demotes the
 * record's heard flag exactly while a sounded critical is muted. Returns null when `raw` is not a
 * record (a status file written before v1.187.3, or a malformed field); the caller then seeds the
 * criticals of the red announcement on record. Only cell-spread criticals (soundedCritPersists).
 * The caller keeps each entry's last-present time from disk for the next write (the boot stamp is
 * for the hold only), so the age bound counts from when the critical was last present, however
 * many restarts follow. Pure + exported for tests.
 */
export function restoreSoundedCriticals(
  raw: unknown,
  bootMs: number,
  maxAgeMs = SOUNDED_CRIT_RESTORE_MAX_AGE_MS,
): Map<string, number> | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = new Map<string, number>();
  for (const [f, at] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFingerprint(f) || typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (!soundedCritPersists(f)) continue;
    if (bootMs - at > maxAgeMs) continue;
    out.set(f, bootMs);
  }
  return out;
}

/**
 * v1.187.0 — the REPEAT-WARNING storm gate. The identical-message gate compares the whole
 * spoken text, and a warning's text carries its live reading ("spread is 58 mV … peer z-score
 * 7.9"), so it never matched a repeat of one alert: on 2026-09-29 the same Core 1 pack 1
 * warning was freshly rendered and spoken at 15:16, 15:21 and 15:26, each time the 2-minute
 * same-level gap had lapsed. A repeating yellow is now recognised by a STABLE identity: the
 * fingerprint of the alert it names aloud (pickPrimaryAlert — id + title + fault, as
 * redReplayGate uses), its rung, and the set of counted warnings.
 *
 * Suppressed only when ALL hold: the last condition yellow that reached the speakers named the
 * same alert at the same rung; every warning counted now was counted then (a warning nobody has
 * heard about is never swallowed behind one they have); it was less than
 * SAME_WARNING_REPEAT_GAP_MS ago; and no condition green or red has been put on the speakers
 * since (the memory is dropped at that dispatch, in runBroadcastAttempt). Once an all-clear has
 * been spoken the warning is news again — suppressing it would leave "All clear" as the last
 * word while the warning stands. Pure + exported for tests.
 */
export const SAME_WARNING_REPEAT_GAP_MS = 30 * 60_000;
export interface VoicedWarning { voicedFp: string; rung: AlarmRung; warnFps: readonly string[]; atMs: number }
export function sameWarningRepeat(
  current: { voicedFp: string | null; rung: AlarmRung; warnFps: readonly string[] },
  last: VoicedWarning | null,
  nowMs: number,
  gapMs = SAME_WARNING_REPEAT_GAP_MS,
): boolean {
  if (last == null || current.voicedFp == null) return false;
  if (nowMs < last.atMs || nowMs - last.atMs >= gapMs) return false;
  if (current.voicedFp !== last.voicedFp || current.rung !== last.rung) return false;
  return current.warnFps.every((f) => last.warnFps.includes(f));
}

/**
 * v1.187.0 — a storm-gate suppression is not a broadcast. runBroadcastAttempt answers one with
 * ok:false and a lone `suppressed: …` error before anything is rendered or dispatched, and the
 * callers stamped that as the last broadcast with outcome 'partial': on 2026-09-29
 * /api/broadcast/status reported a 15:41:10 green 'partial' while the last words actually
 * spoken were the 15:38 red. A suppression is now recorded apart (lastSuppressed*). Pure +
 * exported for tests.
 */
export function isStormSuppression(result: { errors: readonly string[] }): boolean {
  return result.errors.length > 0 && result.errors.every((e) => e.startsWith('suppressed:'));
}

/* ─── monitor ─────────────────────────────────────────────────────── */

export interface BroadcastMonitor {
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[]; cooldownRemainingMs?: number }>;
  /**
   * v0.11.0 — render (and optionally play) a per-priority preview announcement
   * for the Alert Settings page. `target: 'browser'` renders only and returns
   * the WAV path for the browser to play via apiUrl(audioPath); `target:
   * 'speakers'` ALSO plays it to every configured speaker — the Music Assistant
   * targets AND the SIP cordless (v1.186.4). v1.186.4 — takes a RUNG, so the
   * all-clear (`clear`) can be auditioned like the four priorities.
   */
  preview: (
    rung: AlarmRung,
    target: 'browser' | 'speakers',
  ) => Promise<{
    ok: boolean;
    spokenText: string;
    audioPath?: string;
    played: 'browser' | 'speakers';
    error?: string;
    cooldownRemainingMs?: number;
    /** v1.186.4 — speakers that accepted the preview (MA targets + SIP). */
    delivered?: number;
    /** v1.186.4 — a caveat the operator should see beside the result. */
    note?: string;
  }>;
  /**
   * v0.12.0 — fire a dedicated, edge-triggered audible announcement for one
   * backup-pool SoC threshold crossing. Renders chime(klaxonLevelForPriority)
   * + spoken `message` and plays it to BROADCAST_TARGETS via
   * the SAME Music-Assistant path as runBroadcast()/test(). The SoC monitor
   * already edge-limits crossings, so this skips test()/preview() cooldowns.
   * No-ops (returns { ok:false, error:'broadcast disabled' }) when BROADCAST
   * is off. Never throws.
   */
  /**
   * v1.67.0 — `messageEs` is REQUIRED, and `null` must be explicit. It used to be
   * optional, and two call sites simply omitted it: the night-charge notice and the
   * CRITICAL reserve-revert failure. A missing Spanish string does NOT produce a
   * monolingual broadcast — `bilingual` requires a non-empty messageEs, so it falls
   * through to the legacy `announceRepeat` path and plays ENGLISH TWICE. That shipped
   * and the household heard it. Making the parameter required turns the omission into
   * a compile error instead of a silently wrong broadcast.
   */
  announce: (
    priority: AlarmPriority, message: string, messageEs: string | null,
    opts?: { consentNotice?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
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
  /** v1.187.0 — the last storm-gate suppression, recorded APART from the last broadcast: a
   *  suppression renders and dispatches nothing, so it no longer becomes lastBroadcastAt /
   *  lastLevel / lastOutcome ('partial' there means a delivery that partly failed). */
  lastSuppressedAt: number | null;
  lastSuppressedLevel: ConditionLevel | null;
  lastSuppressedKind: BroadcastKind | null;
  lastSuppressedReason: string | null;
  /** v0.84.0 — audible-delivery health. `reachable`: true / false(confirmed) /
   *  null(unprobed or N/A). `usableTargets`: configured speakers currently not
   *  `unavailable`. `reason`: why it's unreachable. Feeds the operator self-alert
   *  (system-audible-unreachable) + the HA diagnostic sensors. */
  audibleReachable: boolean | null;
  audibleUsableTargets: number;
  audibleReason: string | null;
  /** v1.186.0 — the denominator for audibleUsableTargets: configured Music Assistant targets
   *  only (`targetCount` also counts the SIP targets, which the probe does not read). */
  audibleConfiguredTargets: number;
  /** v1.186.0 — CONFIRMED (debounced) fewer usable MA targets than configured, and which. */
  audibleDegraded: boolean;
  audibleUnusableTargets: string[];
  /** v1.186.0 — what the last broadcast was: a condition transition, a dedicated announcement,
   *  an operator test or a settings-page preview. lastLevel/lastOutcome describe it. */
  lastBroadcastKind: BroadcastKind | 'preview' | null;
  /** v1.186.0 — the persisted CONDITION record the next boot's restart baseline is read from
   *  (conditionBootBaseline), and the baseline this boot used. */
  conditionLevel: ConditionLevel | null;
  conditionSpoken: boolean;
  conditionAt: number | null;
  bootBaselineLevel: ConditionLevel | null;
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
  /** v1.186.0 — test seams: the Wyoming renderer (audioRenderer's own injectable, v1.47.4) and
   *  the condition-tick period. Production passes neither. */
  renderTts?: RenderOptions['renderTts'];
  tickMs?: number;
  /**
   * v1.187.3 — since when the alert set the condition is read from has been SETTLED (the alert
   * monitor's AlertMonitor.alertSetSettledSince, wired in index.ts), or null while it is not. Only
   * isRestartRecovery reads it. Absent, throwing or not a finite number ⇒ never settled: a green
   * inside the post-restart warm-up is held and then adopted as a silent continuation, the
   * pre-v1.187.3 outcome.
   */
  alertSetSettledSince?: () => number | null;
}

/** v1.48.3 — true when EVERY per-target SIP dispatch failure is timeout-classed.
 *  A timeout means the HTTP response was lost, NOT that the service didn't run —
 *  under HA load the call regularly executes server-side after the client gives
 *  up, so delivery is UNKNOWN (verified against entity state) rather than
 *  failed. Any non-timeout failure in the set makes the whole dispatch a
 *  definite miss. Exported for tests. */
/** v1.118.0 — ONE classifier for one question, shared by both dispatch paths so
 *  they cannot drift apart. `ETIMEDOUT` has no word break, which the original
 *  /timeout|abort/ missed. Widening is safe in both callers because a positive
 *  verdict only means "delivery UNKNOWN" — it is always followed by an
 *  entity-state probe, and a target that is NOT playing still counts as a real
 *  miss and still retries. */
const TIMEOUT_LIKE = /timeout|timed\s?out|abort/i;

/** Severity ladder for the deferred-retry slot. */
export const RETRY_LEVEL_RANK: Record<ConditionLevel, number> = { green: 0, yellow: 1, red: 2 };

/**
 * v1.122.0 — who owns the single deferred-retry slot.
 *
 * THE DEFECT: there was one `retryTimer` and one `retryAttempt` for the whole
 * monitor, but runBroadcastInner serves both the condition-transition path AND
 * the dedicated announce() path used by the SoC ladder, the runway alarm and the
 * night-charge notice. The retry exists for an HA/MA restart window in which
 * every speaker is briefly unavailable — precisely a window in which SEVERAL
 * alarms defer in a row. A critical deferred at T+0 was erased at T+25 s by a
 * routine yellow deferral (clearTimeout, nothing logged), and the household heard
 * only the yellow. The shared counter compounded it: three yellow deferrals
 * exhausted the budget, so the next red got "giving up after 3 deferred retries"
 * without a single attempt.
 *
 * Pure so the precedence rule is testable on its own.
 */
export function retrySlotDecision(
  pending: { level: ConditionLevel; attempt: number } | null,
  incoming: ConditionLevel,
  maxAttempts: number,
): { action: 'keep-pending' | 'arm' | 'give-up'; attempt: number } {
  // A pending retry for a MORE severe level is never superseded by a less severe
  // one: un-heard is indistinguishable from never-said, so the more severe
  // message is the one that must survive the contention.
  if (pending && RETRY_LEVEL_RANK[incoming] < RETRY_LEVEL_RANK[pending.level]) {
    return { action: 'keep-pending', attempt: pending.attempt };
  }
  // A MORE severe condition gets a fresh budget — yellow churn must not spend
  // the red's retries.
  const attempt = pending && RETRY_LEVEL_RANK[incoming] > RETRY_LEVEL_RANK[pending.level]
    ? 0
    : pending?.attempt ?? 0;
  if (attempt >= maxAttempts) return { action: 'give-up', attempt: 0 };
  return { action: 'arm', attempt: attempt + 1 };
}


/**
 * v1.119.0 — the announce HTTP budget, DERIVED from the clip instead of guessed.
 *
 * `music_assistant.play_announcement` does not return until playback FINISHES,
 * so the only honest budget is "however long this clip plays, plus room for MA
 * queueing and AirPlay/RAOP setup on slow targets". A fixed constant has now
 * rotted three times as clips grew (5 s -> 30 s -> 75 s), most recently on
 * 2026-08-30 when a 68.5 s red clip against a 75 s ceiling made EVERY red time
 * out and get retried — 15 announcements of one storm warning.
 *
 * WAV is 16-bit mono @22050 Hz = 44100 bytes/sec, so bytes give the duration
 * directly. Unknown size falls back to the old ceiling (never tighter than
 * today). PURE.
 */
export const WAV_BYTES_PER_SEC = 44_100;
export const ANNOUNCE_SETUP_MARGIN_MS = 45_000;
export const ANNOUNCE_TIMEOUT_FLOOR_MS = 75_000;
export const ANNOUNCE_TIMEOUT_CEILING_MS = 10 * 60_000;

export function announceTimeoutMs(sizeBytes: number | null | undefined): number {
  if (sizeBytes == null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return ANNOUNCE_TIMEOUT_FLOOR_MS;
  }
  const playMs = (sizeBytes / WAV_BYTES_PER_SEC) * 1000;
  const budget = playMs + ANNOUNCE_SETUP_MARGIN_MS;
  return Math.min(ANNOUNCE_TIMEOUT_CEILING_MS, Math.max(ANNOUNCE_TIMEOUT_FLOOR_MS, Math.round(budget)));
}

/**
 * v1.186.4 — the speaker-preview verdict across BOTH channels. The preview used to
 * reach the Music Assistant targets only, so it never proved the cordless; it now
 * plays to both and reports each. A timeout-shaped SIP failure is UNKNOWN delivery
 * (the call regularly lands after the HTTP response is lost — the v1.48.3 incident
 * on the runBroadcast SIP path), so it is a caveat, not a failure. Exported for tests.
 */
export function previewSpeakerOutcome(
  ma: { targets: number; call: { ok: boolean; verified?: boolean; error?: string } | null },
  sip: { attempted: number; ok: number; errors: string[] },
): { ok: boolean; delivered: number; error?: string; note?: string } {
  const errors: string[] = [];
  const notes: string[] = [];
  let delivered = sip.ok;
  if (ma.call) {
    if (ma.call.ok) delivered += ma.targets;
    else errors.push(`music_assistant.play_announcement: ${ma.call.error}`);
    // ok without verified (v1.122.0): accepted, but playback was not confirmed —
    // the count is what was handed the audio, not what was heard.
    if (ma.call.ok && ma.call.verified === false) notes.push('the Music Assistant speakers did not confirm playback');
  }
  if (sip.errors.length > 0) {
    if (sipTimeoutLike(sip.errors)) notes.push('the cordless did not confirm in time; it usually still rings');
    else errors.push(`SIP play_media: ${sip.errors.join('; ')}`);
  }
  // Switchboard drops identical audio to the same room inside its dedupe window,
  // and a repeated preview of one rung is the same cached render.
  if (sip.attempted > 0) notes.push('the cordless skips the same announcement repeated within a few minutes');
  const note = notes.length ? notes.join('; ') : undefined;
  return errors.length ? { ok: false, delivered, error: errors.join('; '), note } : { ok: true, delivered, note };
}

export function sipTimeoutLike(errors: string[]): boolean {
  return errors.length > 0 && errors.every((e) => TIMEOUT_LIKE.test(e));
}

/** v1.118.0 — the same question for a SINGLE dispatch error (the Music
 *  Assistant path). A timeout/abort means the HTTP response was lost, NOT that
 *  the service failed to run. Exported for tests. */
export function dispatchTimeoutLike(error: string | undefined): boolean {
  return error != null && TIMEOUT_LIKE.test(error);
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
  // v1.187.0 — WHICH criticals and warnings were counted when the standing level was committed
  // (adoptLevel). newCrit / newWarn compare against these: the count alone could not see a
  // different critical replacing a cleared one at the same count.
  let prevCritFps: ReadonlySet<string> = new Set();
  let prevWarnFps: ReadonlySet<string> = new Set();
  // v1.187.0 (log review) — the criticals counted at a committed red, each with the last tick it was
  // present (soundedCriticalHeld refreshes and prunes it every tick). Unlike prevCritFps it
  // outlives a lower commit.
  const soundedCritFps = new Map<string, number>();
  // v1.187.3 (log review, LOW) — for a sounded critical restored at boot and not present since,
  // its last-present time as read from disk (restoreSoundedCriticals). In memory the entry is
  // stamped at the boot, so the outage is not counted as absence; written back that way, every
  // boot renewed it, and restarts less than SOUNDED_VDIFF_ABSENT_HOLD_MS apart kept an absent
  // critical restorable for ever, past both the absent hold and the restore bound. The disk keeps
  // this time instead until the critical is present again (dropped then, in the tick). An entry
  // released meanwhile is never written (persistStatus writes the record's entries only) and is
  // dropped if the critical comes back, before it can be recorded again.
  const soundedCritRestoredAt = new Map<string, number>();
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
  // v1.186.0 — see BroadcastStatus.lastBroadcastKind.
  let lastBroadcastKind: BroadcastStatus['lastBroadcastKind'] = null;
  // v1.186.0 — the CONDITION record (conditionBootBaseline). Written only by the tick's
  // adoptLevel and by a verified condition delivery; tests and dedicated announcements never
  // touch it, so it describes the house rather than whatever played last.
  let conditionLevel: ConditionLevel | null = null;
  let conditionSpoken = false;
  let conditionAt: number | null = null;
  // v1.187.0 — the last storm-gate suppression (see BroadcastStatus.lastSuppressedAt).
  let lastSuppressedAt: number | null = null;
  let lastSuppressedLevel: ConditionLevel | null = null;
  let lastSuppressedKind: BroadcastKind | null = null;
  let lastSuppressedReason: string | null = null;

  // v0.15.18 — the last-broadcast summary survives restarts. Before this,
  // every deploy blanked lastBroadcastAt/lastOutcome/lastSpokenMessage, so
  // "what played last and did it work" was unanswerable right after the
  // restarts that most need auditing.
  const STATUS_PATH = resolve(process.cwd(), config.dbPath, '..', 'broadcast-last.json');
  // v1.187.3 (log review) — the sounded record's last write (restoreSoundedCriticals): the set it
  // wrote, and when. A failed write counts too, so a broken disk is retried on the same cadence.
  // v1.187.3 (log review, LOW) — only the entries that can hold after a restart are written, and
  // only their set drives a write (soundedCritPersists).
  const soundedCritKept = (): Array<[string, number]> => [...soundedCritFps].filter(([f]) => soundedCritPersists(f));
  const soundedCritKeys = (): string => JSON.stringify(soundedCritKept().map(([f]) => f).sort());
  let soundedCritWritten = { keys: '[]', atMs: 0 };
  const persistStatus = () => {
    try {
      writeFileSync(
        STATUS_PATH,
        JSON.stringify({
          lastBroadcastAt, lastLevel, lastOutcome, lastErrors, lastSpokenMessage, lastRender,
          lastBroadcastKind, conditionLevel, conditionSpoken, conditionAt, // v1.186.0
          lastSuppressedAt, lastSuppressedLevel, lastSuppressedKind, lastSuppressedReason, // v1.187.0
          soundedCrit: Object.fromEntries(soundedCritKept().map(([f, at]) => [f, soundedCritRestoredAt.get(f) ?? at])), // v1.187.3 (restoreSoundedCriticals)
        }),
      );
    } catch { /* best-effort */ }
    soundedCritWritten = { keys: soundedCritKeys(), atMs: Date.now() };
  };
  let persistedCondition: { conditionLevel?: unknown; conditionSpoken?: unknown } | null = null;
  let persistedSoundedCrit: unknown = undefined; // v1.187.3 (restoreSoundedCriticals)
  try {
    const s = JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as Partial<{
      lastBroadcastAt: number; lastLevel: ConditionLevel; lastOutcome: BroadcastStatus['lastOutcome'];
      lastErrors: string[]; lastSpokenMessage: string; lastRender: BroadcastStatus['lastRender'];
      lastBroadcastKind: BroadcastStatus['lastBroadcastKind'];
      conditionLevel: unknown; conditionSpoken: unknown; conditionAt: unknown;
      lastSuppressedAt: unknown; lastSuppressedLevel: unknown; lastSuppressedKind: unknown; lastSuppressedReason: unknown;
      soundedCrit: unknown;
    }>;
    lastBroadcastAt = s.lastBroadcastAt ?? null;
    lastLevel = s.lastLevel ?? null;
    lastOutcome = s.lastOutcome ?? null;
    lastErrors = Array.isArray(s.lastErrors) ? s.lastErrors : [];
    lastSpokenMessage = s.lastSpokenMessage ?? null;
    if (s.lastRender) lastRender = s.lastRender;
    lastBroadcastKind = s.lastBroadcastKind ?? null;
    persistedCondition = s;
    const cl = s.conditionLevel;
    conditionLevel = cl === 'green' || cl === 'yellow' || cl === 'red' ? cl : null;
    conditionSpoken = s.conditionSpoken === true;
    conditionAt = typeof s.conditionAt === 'number' ? s.conditionAt : null;
    // v1.187.0 — the suppression record (additive; absent in files written before v1.187.0).
    lastSuppressedAt = typeof s.lastSuppressedAt === 'number' ? s.lastSuppressedAt : null;
    const sl = s.lastSuppressedLevel;
    lastSuppressedLevel = sl === 'green' || sl === 'yellow' || sl === 'red' ? sl : null;
    const sk = s.lastSuppressedKind;
    lastSuppressedKind = sk === 'condition' || sk === 'dedicated' || sk === 'test' ? sk : null;
    lastSuppressedReason = typeof s.lastSuppressedReason === 'string' ? s.lastSuppressedReason : null;
    persistedSoundedCrit = s.soundedCrit;
  } catch { /* first boot / no prior state */ }
  // v0.58.0 — restart-continuation baseline (used only to suppress a re-spoken
  // YELLOW/GREEN advisory; criticals are never suppressed — see isRestartContinuation).
  // Only adopt the persisted level when the last broadcast actually SUCCEEDED (the
  // operator heard it); a failed/never-played pre-restart broadcast must still re-fire.
  // v1.186.0 — read from the CONDITION record, not from lastLevel/lastOutcome: those also
  // carry tests and dedicated announcements (see conditionBootBaseline).
  const bootMs = Date.now();
  const bootBaselineLevel: ConditionLevel | null = conditionBootBaseline(persistedCondition);
  /**
   * v1.187.3 — the baseline the continuation gate still reads. A recovery (isRestartRecovery)
   * ends it: once the house has been told the condition cleared, a warning inside the rest of the
   * warm-up is news, not the continuation of a level the house heard before the restart.
   */
  let continuationBaseline: ConditionLevel | null = bootBaselineLevel;
  /** v1.187.3 — BroadcastMonitorOpts.alertSetSettledSince, read defensively: absent, throwing or
   *  not a finite number ⇒ not settled. */
  const alertSetSettledSince = (): number | null => {
    try {
      const v = opts.alertSetSettledSince?.();
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch { return null; }
  };
  // v1.64.0 — identity-aware RED replay gate (see redReplayGate.ts). Constructed
  // here so the state read happens once, at boot: that read IS the restart
  // boundary. Note it is deliberately NOT keyed off bootBaselineLevel/lastOutcome
  // above — it carries its own evidence (WHICH criticals were spoken, and WHEN),
  // because a level alone cannot answer "is this the same fault?".
  const redReplayGate = createRedReplayGate({ windowMs: BROADCAST_BOOT_WARMUP_MS });
  // v1.187.3 (log review) — the sounded criticals of before the restart, restored BEFORE the first
  // tick (restoreSoundedCriticals): soundedCriticalHeld then holds a sounded vdiff-crit that is
  // muted again, or absent between two readings, exactly as in one process — the green clock never
  // starts, so there is no recovery and no all-clear with its card open. A status file written
  // before v1.187.3 has no record: under a committed red the criticals of the red announcement on
  // record are seeded instead (that evidence is cleared at the first green observed under a hold, so
  // it is read here, at boot, before any tick).
  {
    const restored = restoreSoundedCriticals(persistedSoundedCrit, bootMs);
    // v1.187.3 (log review, LOW) — the disk keeps each restored entry's own last-present time (never
    // later than the boot: a clock stepped back must not keep it fresh) until it is present again.
    if (restored != null) for (const f of restored.keys()) soundedCritRestoredAt.set(f, Math.min((persistedSoundedCrit as Record<string, number>)[f], bootMs));
    // v1.187.3 (log review, LOW) — the fallback keys on the COMMITTED red on record, not on a heard
    // one: the hold demotes the heard flag exactly while a sounded critical is muted, so the upgrade
    // restart itself, landing inside such a hold, seeded nothing (and a committed yellow, the red's
    // criticals released, still seeds nothing).
    const seeded = restored ?? new Map<string, number>(
      persistedCondition?.conditionLevel === 'red'
        ? (redReplayGate.state()?.activeFingerprints ?? []).filter((f) => soundedCritPersists(f)).map((f) => [f, bootMs])
        : [],
    );
    for (const [f, at] of seeded) soundedCritFps.set(f, at);
    if (seeded.size > 0) {
      log(`broadcast: ${seeded.size} sounded critical(s) of before the restart restored${restored == null ? ' from the red announcement on record' : ''} (${[...seeded.keys()].map(describeFingerprint).join('; ')}) — held, not cleared, while muted by a bounded cell-spread mute or (a cell-spread critical) gone under ${Math.round(SOUNDED_VDIFF_ABSENT_HOLD_MS / 60_000)} minutes`);
    }
  }
  /**
   * v1.64.0 — the ONE place a condition level is committed as `prevLevel`.
   *
   * ★★★ Committing GREEN destroys the red-replay evidence. Reaching green is an
   * ALL-CLEAR: whatever happens next is a NEW event, not a replay of the red we
   * announced before it, and a red that cleared and re-raised inside the 30-min
   * gap must klaxon. Every path that adopts a level goes through here so no
   * future branch can adopt green and leave stale evidence behind.
   * v1.187.0 (review) — the de-escalation dwell delays a green COMMIT by up to 3 min, so the
   * tick also destroys the evidence when green is first OBSERVED under a held de-escalation
   * (see the hold branch): a restart inside the dwell must not keep evidence that a committed
   * green would have destroyed.
   *
   * ★★★ `firstTick` deliberately does NOT use this. The very first observation
   * after a restart usually sees an EMPTY alert store (green) purely because
   * telemetry has not populated yet — that is not an all-clear, and wiping the
   * state on it would turn this whole gate into a no-op on every boot.
   */
  const adoptLevel = (
    l: ConditionLevel,
    c: number,
    // v1.187.0 — REQUIRED: the fingerprints counted at this commit. A caller that omitted them
    // would commit an empty set, and every standing critical would read as new next tick.
    ids: { crit: readonly string[]; warn: readonly string[] },
    heard = false,
  ): void => {
    // v1.187.0 (review) — while the committed level STAYS red, the committed criticals ACCUMULATE
    // instead of being replaced. Replaced, a standing critical whose fingerprint alternates (one
    // dpu-err / shp2-src-err id whose fault code flips between two values) read as "new" on every
    // flip and re-sounded the klaxon each time the 2-min same-level gap lapsed; the identical-
    // message gate could not see it, because the two texts alternate. Accumulated, each distinct
    // critical is announced once per red episode, and a fingerprint never counted in it (the
    // replacement-at-the-same-count case) still reads as new. Any commit of a lower level ends the
    // episode and starts the set afresh. Computed before prevLevel is overwritten.
    prevCritFps = l === 'red' && prevLevel === 'red' ? new Set([...prevCritFps, ...ids.crit]) : new Set(ids.crit);
    // v1.187.0 (log review) — a red commit records what sounded (soundedCriticalHeld).
    if (l === 'red') for (const f of ids.crit) soundedCritFps.set(f, Date.now());
    prevLevel = l;
    prevCrit = c;
    prevWarnFps = new Set(ids.warn);
    // v1.187.0 — a commit ends any held de-escalation, and supersedes a storm-gated condition that
    // was waiting to be re-presented: whatever the condition is now, it is decided afresh.
    deescalationHold = null;
    deferredCondition = null;
    // v1.187.1 — and a pending boot hold: the held condition was adopted, not dropped.
    bootYellowHold = null;
    bootRedHold = null;
    if (clearsRedReplayEvidence(l)) redReplayGate.noteConditionGreen();
    // v1.186.0 — every adoption refreshes the condition record, SILENT ones included (quiet
    // hours, the all-clear speech gate, a storm-gated or disabled transition): the next boot's
    // baseline must describe the house, and a green adopted in silence must not leave an older
    // yellow standing as the baseline. `heard` is true only for a continuation of a level the
    // household already heard (restart continuation, red replay); a transition starts unheard
    // and a VERIFIED condition delivery of it marks it heard (runBroadcastAttempt).
    conditionLevel = l;
    conditionSpoken = heard;
    conditionAt = Date.now();
    persistStatus();
  };

  // v0.15.18 — single-slot deferred retry for broadcasts that could not be
  // verified (targets unavailable during an HA/MA restart, MA call failure,
  // or a "completed" too fast for any audio to have played). A new genuine
  // broadcast supersedes the pending retry.
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  // v1.122.0 — the level the PENDING retry belongs to (null when none is armed).
  //
  // THE DEFECT: this was one slot and one counter for the whole monitor, but
  // runBroadcastInner serves both the condition-transition path AND the dedicated
  // announce() path used by the SoC ladder, the runway alarm and the night-charge
  // notice. The scenario the retry exists for is an HA/MA restart window in which
  // every speaker is briefly unavailable — precisely a window in which SEVERAL
  // alarms defer in a row. A critical announcement deferred at T+0 was then erased
  // at T+25 s by a routine yellow deferral (clearTimeout with nothing logged), and
  // the household heard only the yellow. The shared counter compounded it: three
  // yellow deferrals exhausted the budget, so the next red got
  // "giving up after 3 deferred retries" without a single attempt.
  let retryLevel: ConditionLevel | null = null;
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
  /**
   * v1.159.0 — release the deferred-retry slot when no retry is armed.
   *
   * The slot now outlives the timer (see the setTimeout below), so it must be cleared when
   * a broadcast ends without arming a new retry — a verified delivery, an unverified one,
   * or a give-up. Otherwise a stale `retryLevel` would make every later lower-level
   * deferral "keep-pending" against a retry that does not exist, and no retry would ever
   * be armed again.
   *
   * v1.160.0 — called from runBroadcastInner's `finally`, so it covers the early exits
   * (storm gates, no targets, not supervised, render failure) as well as the completion
   * tail. A fired retry that is absorbed by the same-level storm gate used to leave the
   * slot held forever.
   */
  const releaseRetrySlotIfIdle = () => {
    if (retryTimer == null) { retryAttempt = 0; retryLevel = null; }
  };
  const scheduleBroadcastRetry = (level: ConditionLevel, rung: AlarmRung, message: string | null, messageEs: string | null, reason: string, kind: BroadcastKind) => {
    // v1.186.0 — a TEST never takes the single deferred-retry slot. A failed test that armed a
    // retry superseded any milder real alarm's pending retry (yellow lost to "This is only a
    // test"), and its replay ran as an ordinary broadcast. The operator who asked for the test
    // has the failure in the HTTP response.
    if (kind === 'test') {
      log(`broadcast: TEST ${level} not retried (${reason}) — the deferred-retry slot is kept for real alarms`);
      return;
    }
    const pending = retryTimer != null && retryLevel != null
      ? { level: retryLevel, attempt: retryAttempt }
      : retryLevel != null ? { level: retryLevel, attempt: retryAttempt } : null;
    const decision = retrySlotDecision(pending, level, RETRY_DELAYS_MS.length);
    if (decision.action === 'keep-pending') {
      log(`broadcast: keeping the pending ${retryLevel} retry — a ${level} deferral does not supersede it (${reason})`);
      return;
    }
    if (decision.action === 'give-up') {
      log(`broadcast: giving up after ${RETRY_DELAYS_MS.length} deferred ${level} retries (${reason})`);
      retryAttempt = 0;
      retryLevel = null;
      return;
    }
    const delay = RETRY_DELAYS_MS[decision.attempt - 1];
    retryAttempt = decision.attempt;
    if (retryTimer) {
      // v1.122.0 — say so. This used to discard a pending retry in silence.
      log(`broadcast: superseding the pending ${retryLevel ?? '?'} retry with ${level}`);
      clearTimeout(retryTimer);
    }
    retryLevel = level;
    log(`broadcast: ${reason} — deferred retry ${retryAttempt}/${RETRY_DELAYS_MS.length} in ${Math.round(delay / 1000)}s`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // v1.159.0 — do NOT clear retryLevel here. scheduleBroadcastRetry only sees a pending
      // slot while `retryLevel != null`, so clearing it at fire time made every subsequent
      // failure start from attempt 0: the budget never counted past 1 and the retry could
      // never give up. Observed 2026-09-15 20:47:12 / 20:50:16 / 20:53:20 — three
      // consecutive "deferred retry 1/3" for one condition while music_assistant
      // .play_announcement returned HTTP 500, each cycle re-announcing. The slot is
      // released by releaseRetrySlotIfIdle() when a broadcast ends with no retry pending.
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
        retryLevel = null;
        return;
      }
      // v1.25.0 — skipSip: this retry exists to reach the MA targets that were
      // unavailable; the SIP target already received this exact audio on the first
      // dispatch, so re-firing it would replay the identical alarm on the cordless.
      // v1.32.0 — but ONLY skip when the first SIP dispatch actually DELIVERED
      // (lastSipDispatchOk); a failed SIP dispatch is retried alongside MA.
      // v1.186.0 — the retry keeps the kind it was armed for (condition or dedicated).
      void runBroadcast(level, rung, message, false, messageEs, lastSipDispatchOk, kind);
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
  // v1.186.0 — and they never ARM them: a test's verified delivery is not evidence that
  // anything real was said. The same-level gap is armed by CONDITION deliveries only
  // (lastConditionPlayed*); a dedicated announcement (SoC ladder, runway, night-charge notice)
  // arms the identical-message gate but no longer the same-level gap. The condition level
  // excludes every id those announcers own, so a same-level gap armed by one of them could only
  // ever silence a DIFFERENT alarm — with no retry, since the tick has already adopted it.
  const SAME_LEVEL_GAP_MS = 2 * 60 * 1000;
  const SAME_MESSAGE_GAP_MS = 10 * 60 * 1000;
  let lastPlayedAt = 0;
  let lastPlayedLevel: ConditionLevel | null = null;
  let lastPlayedMessage: string | null = null;
  let lastConditionPlayedAt = 0;
  let lastConditionPlayedLevel: ConditionLevel | null = null;
  let stormSuppressedCount = 0;
  // v1.187.0 — the last condition yellow that reached the speakers (sameWarningRepeat). Set by
  // the tick on a delivered yellow; dropped the moment a condition green or red passes the
  // storm gates on its way to the speakers.
  let lastVoicedWarning: VoicedWarning | null = null;
  /** v1.187.0 — record a storm-gate suppression apart from the last broadcast. */
  const noteSuppression = (level: ConditionLevel, kind: BroadcastKind, reason: string): void => {
    lastSuppressedAt = Date.now();
    lastSuppressedLevel = level;
    lastSuppressedKind = kind;
    lastSuppressedReason = reason;
    persistStatus();
  };

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
  // v1.186.0 — the degraded channel (audibleDegradedStep): usable < configured, debounced.
  let degradedStreak = 0;
  let audibleDegraded = false;
  let audibleUnusable: string[] = [];
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
        degraded: audibleDegraded, // v1.186.0
        unusableTargets: [...audibleUnusable],
      });
      // Audible not applicable (disabled or unsupervised) → unknown, never alarms.
      if (!supervised || !cfg.enabled) {
        unreachableStreak = 0; audibleReachable = null; audibleUsableTargets = 0; audibleReason = null;
        degradedStreak = 0; audibleDegraded = false; audibleUnusable = [];
        publish();
        return;
      }
      // Enabled but no speakers configured → a persistent config error, report it
      // immediately (not a transient restart, so no debounce needed).
      if (cfg.targets.length === 0) {
        unreachableStreak = AUDIBLE_UNREACHABLE_CONFIRM; audibleReachable = false; audibleUsableTargets = 0;
        audibleReason = 'no speakers configured (BROADCAST_TARGETS empty)';
        degradedStreak = 0; audibleDegraded = false; audibleUnusable = [];
        publish();
        return;
      }
      const states = await Promise.all(cfg.targets.map((t) => getEntityState(t).catch(() => null)));
      // v1.186.0 — classified per target, so the degraded alert can NAME what is missing.
      const probed = classifyAudibleTargets(cfg.targets, states);
      const usable = probed.usable.length;
      const degraded = audibleDegradedStep(degradedStreak, cfg.targets.length, usable, AUDIBLE_UNREACHABLE_CONFIRM);
      if (degraded.degraded && !audibleDegraded) {
        log(`broadcast: audible channel DEGRADED — ${usable} of ${cfg.targets.length} Music Assistant target(s) usable; not reachable: ${probed.unusable.join(', ')}`);
      } else if (!degraded.degraded && audibleDegraded) {
        log(`broadcast: audible channel restored — all ${cfg.targets.length} Music Assistant target(s) usable`);
      }
      degradedStreak = degraded.streak;
      audibleDegraded = degraded.degraded;
      audibleUnusable = probed.unusable;
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
  const audibleHealthInterval = setInterval(() => {
    // v1.48.4 — self-heal the MA service-detection flag. A CONFIRMED-absent at
    // boot (MA still restarting after an HA/OS update deregisters its services)
    // previously stuck until an operator ran a manual test broadcast: the boot
    // probe was the only unconditional check, and real broadcasts don't gate on
    // the flag, so nothing ever corrected the status. Live incident: HA OS 18.1
    // update → MA wedged at add-on boot → flag false for hours while the
    // service was long since registered. One cheap re-probe per health tick,
    // only while the flag is down.
    if (supervised && !musicAssistantAvailable) void detectMusicAssistant({ retries: 0 });
    computeAudibleHealth().catch(onProbeError);
  }, AUDIBLE_HEALTH_PROBE_MS);
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
  // v1.122.0 — `verified` is a THIRD state, distinct from ok.
  //
  // v1.118.1 correctly stopped RETRYING on a timeout by returning ok:true, but
  // ok:true is also the sole input to two downstream "this was verifiably heard"
  // decisions: redReplayGate.noteRedAnnounced and the storm gate's lastPlayed
  // commit. One flag was carrying two meanings — "do not retry" and "the
  // household heard it" — and the timeout path is exactly the case where the
  // second is unknown. The log line at that branch literally says "delivery
  // UNKNOWN" while the code files it as heard.
  //
  // ok=true, verified=false means: do not retry (a retry storm is worse), but do
  // not spend this as evidence that the alarm was delivered either.
  const playAnnounce = async (url: string, sizeBytes?: number | null): Promise<{ ok: boolean; verified: boolean; error?: string }> => {
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
      // v1.119.0 — budget sized to THIS clip (see announceTimeoutMs), so a long
      // announcement completes instead of timing out and being replayed.
      const budgetMs = announceTimeoutMs(sizeBytes);
      last = await callHaService('music_assistant', 'play_announcement', params, {
        headersTimeoutMs: budgetMs,
        bodyTimeoutMs: budgetMs + 45_000,
      });
      if (last.ok) return { ok: true, verified: true };
      // v1.118.0 — A TIMEOUT IS NOT A FAILURE. Same lesson v1.48.3 learned on
      // the SIP path, which this path never got: under load Music Assistant
      // regularly starts playing and answers the HTTP call late, so a
      // "Headers Timeout Error" means delivery is UNKNOWN, not missed.
      // Retrying it re-plays audio that is already sounding.
      //
      // LIVE INCIDENT 2026-08-30 20:39 MST: a Severe Thunderstorm Warning red
      // timed out on every attempt while the audio played each time — 2 in-call
      // attempts x 3 deferred rounds = ~6 announcements of the same alert into
      // the house, during the storm the alert was warning about. The operator
      // reported "lots of announcements playing" while the log read "failed".
      //
      // So: verify against the players' real state (~8 s in, mid-announce for
      // any real playback) and treat confirmed playback as success. A
      // non-timeout failure (4xx/5xx/refused) is still a definite miss and
      // still retries — that path is unchanged.
      if (dispatchTimeoutLike(last.error)) {
        // v1.118.1 — a timeout is TERMINAL-UNKNOWN: stop, do not retry.
        //
        // v1.118.0 tried to settle it by probing the players' state, copying
        // the SIP fix. That probe cannot work here and made things worse: the
        // service call itself blocks for its full ~80 s timeout, so the probe
        // runs ~88 s after dispatch — by which point a few-seconds-long
        // announcement has finished and every player reads `idle`. Worse, the
        // probe uses the same HA API that just timed out, so under the load
        // that CAUSED the timeout it returns null and reads as "not playing".
        // Both failure modes resolve to "real miss" and retry — the exact
        // duplication being fixed. Measured live 2026-08-30 20:59-21:01.
        //
        // What the vendor log proves: MA received and PLAYED every timed-out
        // call ("Playback announcement to player ... Streaming via AirPlay 2").
        // A Headers Timeout means the request was accepted and the RESPONSE was
        // slow — not that the service failed. A hard-down MA refuses the
        // connection instead, which is a non-timeout error and still retries.
        //
        // The asymmetry that settles it: the HA push notification is dispatched
        // separately and succeeded throughout this incident, so the operator is
        // informed either way. Audio is the redundant channel. One possibly
        // missed announcement beats six duplicates of a storm warning.
        log(
          'broadcast: play_announcement timed out — delivery UNKNOWN (MA answers slowly under load but does play); ' +
          'not retrying, so the alert cannot announce twice. The HA push notification is the guaranteed channel.',
        );
        return { ok: true, verified: false };
      }
      if (attempt < cfg.announceRetries) {
        log(`broadcast: play_announcement failed (attempt ${attempt + 1}/${cfg.announceRetries + 1}), retrying — ${last.error ?? last.status}`);
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return { ok: false, verified: false, error: `${last.error ?? last.status}` };
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

  // v1.186.0 — the BroadcastKind of the attempt about to run (set by runBroadcastInner).
  let attemptKind: BroadcastKind = 'dedicated';

  /**
   * Single broadcast: render → one MA call. No staggering, no settles.
   */
  const runBroadcastAttempt = async (
    level: ConditionLevel,
    // v1.59.0 — the severity RUNG picks the tone; `level` stays the private
    // annunciation-policy axis every suppression gate already speaks. Passing
    // both keeps those gates byte-identical while the audio gains 5-way detail.
    rung: AlarmRung,
    message: string | null,
    messageEs: string | null,
    bypassStormGate: boolean,
    skipSip = false, // v1.25.0 — true on a deferred MA retry: SIP already got the first dispatch.
  ): Promise<{ ok: boolean; errors: string[]; verified?: boolean }> => {
    // v1.186.0 — captured at entry: runBroadcastInner sets it immediately before this call, and
    // the single-flight chain lets no other attempt start until this one settles.
    const kind = attemptKind;
    const tag = kind === 'test' ? 'TEST ' : '';
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
      // v1.64.0 — the rank ladder moved to redReplayGate.ts and is IMPORTED here.
      // Same comparison, byte for byte; the point is that there is now exactly ONE
      // definition of "escalation", shared with the red replay gate's carve-out.
      const escalation = isLevelEscalation(lastPlayedLevel, level);
      if (!escalation) {
        if (message != null && message === lastPlayedMessage && since < SAME_MESSAGE_GAP_MS) {
          stormSuppressedCount += 1;
          noteSuppression(level, kind, 'identical message within gap'); // v1.187.0
          log(`broadcast: ${level} suppressed — identical message played ${Math.round(since / 1000)}s ago (storm gate)`);
          return { ok: false, errors: ['suppressed: identical message within gap'] };
        }
        // v1.186.0 — the same-level gap runs from the last CONDITION delivery (see the gate
        // constants). An escalation over EITHER reference still plays, so no broadcast is
        // refused here that the pre-v1.186.0 gate would have let through.
        const sinceCondition = Date.now() - lastConditionPlayedAt;
        if (lastConditionPlayedAt > 0 && sinceCondition < SAME_LEVEL_GAP_MS && !isLevelEscalation(lastConditionPlayedLevel, level)) {
          stormSuppressedCount += 1;
          noteSuppression(level, kind, 'same-or-lower level within gap'); // v1.187.0
          log(`broadcast: ${level} suppressed — last ${lastConditionPlayedLevel} condition broadcast played ${Math.round(sinceCondition / 1000)}s ago (storm gate)`);
          return { ok: false, errors: ['suppressed: same-or-lower level within gap'] };
        }
      }
    }

    // v1.187.0 — past the storm gates a condition green or red is on its way to the speakers
    // (the SIP side-channel is dispatched before the Music Assistant pre-flight, so it can be
    // heard even when MA defers). From here the house may have heard something newer than the
    // last yellow, so the repeat-warning gate forgets it: the next yellow is spoken. Dropped on
    // the attempt, not on verified delivery — an unknown outcome errs toward speaking.
    if (kind === 'condition' && level !== 'yellow') lastVoicedWarning = null;

    const errors: string[] = [];
    /** v1.122.0 — a dispatch whose delivery is UNKNOWN (MA timeout). */
    let deliveryUnverified = false;
    const t0 = Date.now();

    // 1. Render combined announcement WAV (cache-aware). v0.15.23 — resolve the
    // operator-assigned chime for this level (custom tone or built-in klaxon);
    // resolveChime falls back to the built-in when a custom file is missing.
    // v1.58.0 — NO CAST. These unions coincide today; a cast here would let a
    // future widening of AnnouncementLevel pass silently instead of failing the
    // build at the one site that decides which tone an alarm plays.
    const chime = resolveChime(rung, opts.klaxonDir);
    if (chime.fellBack) log(`broadcast: assigned chime for rung ${rung} missing — using built-in klaxon`);
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
    // v1.67.0 — when the system is CONFIGURED bilingual but a caller supplied no
    // Spanish text, the render silently degrades to the legacy announceRepeat path
    // and says the English twice. That is indistinguishable from a working bilingual
    // broadcast in the log, which is how it went unnoticed. Say so.
    if (cfg.bilingual && secondVoice.length > 0 && (messageEs == null || messageEs.trim().length === 0)
        && message != null && message.trim().length > 0) {
      log('broadcast: bilingual is configured but this message carried no Spanish text — '
        + 'falling back to a monolingual pass (the English may repeat). This is a CALLER bug.');
    }
    const messages = bilingual
      ? [
          { text: message!, lang: 'en' as const },                       // English, default voice
          { text: messageEs!, lang: 'es' as const, voice: secondVoice },  // Spanish voice
        ]
      : undefined;
    const r = await renderAnnouncement({
      level: rung,
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
      renderTts: opts.renderTts, // v1.186.0 — test seam; undefined in production (Wyoming)
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
          // v1.59.0 — SAME rung as the failed attempt. A different one here would
          // make the degraded (chime-only) path announce a different severity
          // than the alarm that actually fired.
          level: rung,
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
          if (r.ok === 0) {
            // v1.48.3 — a TIMEOUT-classed failure means the HTTP RESPONSE was
            // lost, not that the service didn't run: under HA load the
            // play_media call regularly executes server-side after our client
            // gives up. Live incident: the "failed" dispatch had actually
            // placed the call (announce played), the deferred retry re-fired
            // SIP believing 0/1 delivered, and the duplicate arrived while the
            // phone was still in the announce call — it RANG instead of
            // auto-answering. Delivery after a timeout is UNKNOWN, so verify
            // against the entity's real state (~8 s in, mid-announce for any
            // real call) before letting the retry re-fire SIP. A non-timeout
            // failure (4xx/5xx/refused) stays a definite miss and retries.
            if (sipTimeoutLike(r.errors)) {
              const probe = setTimeout(() => {
                void Promise.all(cfg.sipTargets.map((t) => getEntityState(t).catch(() => null)))
                  .then((states) => {
                    const active = states.some((s) => s != null && (s.state === 'playing' || s.state === 'on'));
                    if (active) {
                      lastSipDispatchOk = true;
                      log('broadcast: SIP delivery confirmed via entity state after an HTTP timeout — duplicate re-fire suppressed');
                    } else {
                      log(`broadcast: SIP dispatch timed out and the target is not playing — a deferred retry will re-fire SIP`);
                    }
                  });
              }, 8_000);
              probe.unref?.();
            } else {
              log(`broadcast: SIP dispatch reached 0/${r.attempted} targets — a deferred retry will re-fire SIP`);
            }
          }
        })
        .catch((e) => { lastSipDispatchOk = false; log(`broadcast: SIP dispatch failed — ${e?.message ?? e}`); });
    }

    // 2. v0.15.18 — pre-flight: during HA/MA restart windows the media_player
    // entities briefly deregister; HA then ACCEPTS play_announcement and
    // silently drops it (3 confirmed swallowed broadcasts, each "ok" in
    // 20-34 ms). Verify at least one target is registered and available
    // before dispatching; otherwise defer and retry.
    const states = await Promise.all(cfg.targets.map((t) => getEntityState(t)));
    // v1.186.0 — per target, so a partial channel is named instead of reported as the
    // configured count. HA skips an unavailable entity in the list and the call still succeeds,
    // so "→ ok" alone never showed that one room heard nothing.
    const preflight = classifyAudibleTargets(cfg.targets, states);
    const usable = preflight.usable.length;
    if (usable === 0) {
      errors.push('all broadcast targets unavailable (HA/MA restarting?)');
      scheduleBroadcastRetry(level, rung, message, messageEs, 'all broadcast targets unavailable', kind);
      lastBroadcastAt = Date.now(); lastLevel = level; lastOutcome = 'failure'; lastErrors = errors;
      lastBroadcastKind = kind;
      persistStatus();
      // v0.84.0 — a real broadcast that found ZERO reachable speakers is strong
      // evidence the audible channel is down; freshen the health probe now so the
      // operator self-alert doesn't wait for the next periodic tick to confirm.
      computeAudibleHealth(true).catch(onProbeError);
      log(`broadcast: ${tag}${level} deferred — ${errors[0]}`);
      return { ok: false, errors };
    }
    if (preflight.unusable.length > 0) {
      log(`broadcast: ${tag}${level} — only ${usable} of ${cfg.targets.length} Music Assistant target(s) usable; will not reach ${preflight.unusable.join(', ')}`);
    }

    // 3. Single MA play_announcement to every MA target (the SIP side-channel was
    // already dispatched, fire-and-forget, above).
    const call = await playAnnounce(url, rr.sizeBytes);
    if (!call.ok) {
      errors.push(`music_assistant.play_announcement: ${call.error}`);
      scheduleBroadcastRetry(level, rung, message, messageEs, 'play_announcement failed after in-call retries', kind);
    } else if (!call.verified) {
      // Dispatched, outcome unknown. No retry (v1.118.1) and no verification credit.
      deliveryUnverified = true;
    }

    if (message && !spokenDropped) lastSpokenMessage = message;

    const dt = Date.now() - t0;
    // v0.15.18 — a real MA announcement blocks until playback completes
    // (observed 17-34 s). A sub-2 s "ok" means HA returned without playing
    // (entity registered but its player not ready) — treat as unverified
    // and re-dispatch rather than report a success no one heard.
    if (call.ok && dt < 2000) {
      errors.push(`unverified: completed in ${dt}ms — too fast for real playback`);
      scheduleBroadcastRetry(level, rung, message, messageEs, `suspiciously fast completion (${dt}ms)`, kind);
    }
    if (call.ok && errors.length === 0) {
      // v1.186.0 — a TEST feeds none of the real-alarm bookkeeping below. It bypassed the storm
      // gates and must not arm them (a real red inside ~2 min of a red test was refused, with no
      // retry), it does not reset a real alarm's retry budget, and "This is only a test" carries
      // nobody's pending announcement.
      if (kind !== 'test') {
        retryAttempt = 0; // verified success resets the deferred-retry budget
        // v0.15.22 — storm gates key off VERIFIED playback only, so a failed or
        // unverified dispatch never blocks its own deferred retries.
        lastPlayedAt = Date.now();
        lastPlayedLevel = level;
        lastPlayedMessage = message;
      }
      // v1.186.0 — only a CONDITION delivery arms the same-level gap (see the gate constants).
      if (kind === 'condition') {
        lastConditionPlayedAt = Date.now();
        lastConditionPlayedLevel = level;
      }
      // v1.186.0 — and only a verified condition delivery of the level the tick currently holds
      // marks the condition record heard (the restart baseline). A timed-out dispatch is
      // "delivery UNKNOWN" and earns no credit, as for the red replay gate.
      if (kind === 'condition' && !deliveryUnverified && conditionLevel === level) conditionSpoken = true;
      // v1.88.0 — SINGLE-FLIGHT the two red retry paths. On 2026-08-19 15:02
      // a degraded boot (Piper DNS down + HA 502) armed BOTH the deferred-
      // target retry (30s) and the spoken-render retry (90s); the deferred one
      // delivered the full announcement at 15:02:45 and the spoken retry then
      // played the identical red AGAIN at 15:03:44 — ~130s of klaxon for one
      // condition. A VERIFIED spoken delivery of the same level and text
      // satisfies the pending spoken retry's entire purpose; cancel it.
      // A condition-type pending (message === undefined, v1.48.0 shape) is
      // satisfied by ANY verified spoken delivery at its level — the condition
      // speech re-derives at fire time, so exact text equality would never
      // match. A dedicated-message pending must match its stored text.
      // v1.186.0 — "ANY verified spoken delivery at its level" meant any KIND too: a SoC-ladder
      // red satisfied a render-failed condition red's retry, and the condition's speech was
      // never delivered. A condition-type pending is satisfied by a condition delivery only.
      if (
        pendingSpokenRetry != null &&
        pendingSpokenRetry.level === level &&
        (pendingSpokenRetry.message === undefined
          ? kind === 'condition'
          : (pendingSpokenRetry.message ?? null) === (message ?? null))
      ) {
        pendingSpokenRetry = null;
        log('broadcast: pending spoken retry cancelled — this verified delivery already carried the announcement');
      }
    }
    const renderTag = rr.fromCache ? 'cached' : `rendered+${rr.ttsRenderMs ?? 0}ms`;
    // v1.186.0 — the MA tally is what was USABLE at dispatch, not the configured count.
    const maTally = `${usable}/${cfg.targets.length} MA usable${preflight.unusable.length ? ` (not reached: ${preflight.unusable.join(', ')})` : ''}`;
    if (errors.length === 0) {
      log(`broadcast: ${tag}${level} → ok in ${dt}ms (${maTally}${cfg.sipTargets.length ? ` + ${cfg.sipTargets.length} SIP` : ''} target(s), ${renderTag}, ${rr.sizeBytes ?? '?'} bytes${message ? ', +tts' : ''})`);
    } else {
      log(`broadcast: ${tag}${level} → ${errors.length} error(s) in ${dt}ms (${maTally}): ${errors.join('; ')}`);
    }
    lastBroadcastAt = Date.now(); lastLevel = level; lastBroadcastKind = kind;
    lastOutcome = errors.length === 0 ? 'success' : 'partial';
    lastErrors = errors;
    releaseRetrySlotIfIdle();
    persistStatus();
    return { ok: errors.length === 0, errors, verified: errors.length === 0 && !deliveryUnverified };
  };

  /**
   * v1.160.0 — the retry slot is released on EVERY exit, not just the completion tail.
   *
   * runBroadcastAttempt returns early in six places before it can arm anything: not
   * supervised, no MA targets, the two storm gates, and the two render failures. A
   * DEFERRED RETRY that fires into one of those left the slot HELD WITH NO TIMER —
   * `retryLevel` set, `retryTimer` null — because v1.159.0 released it only at the
   * completion tail. The same-level storm gate is the likely one: the retry replays
   * the same rung ~30 s later, which is exactly what SAME_LEVEL_GAP_MS absorbs.
   *
   * A phantom slot is worse than the defect it came from. Every later milder deferral
   * logs "keeping the pending <level> retry" against a retry that does not exist, so
   * nothing is ever retried again, and the next same-level failure can reach "giving
   * up after 3" having made zero attempts.
   *
   * The tail call is KEPT (it releases before the status is persisted, so a persisted
   * snapshot never shows a phantom slot) and this one is idempotent:
   * releaseRetrySlotIfIdle() is a no-op whenever a timer is armed, and
   * scheduleBroadcastRetry() runs INSIDE the attempt, so a retry armed by this
   * broadcast is always already armed by the time either call runs.
   */
  const runBroadcastInner = async (
    level: ConditionLevel,
    rung: AlarmRung,
    message: string | null,
    messageEs: string | null,
    bypassStormGate: boolean,
    skipSip = false,
    kind: BroadcastKind = 'dedicated',
  ): Promise<{ ok: boolean; errors: string[]; verified?: boolean }> => {
    attemptKind = kind; // v1.186.0 — read once, at entry, by the attempt below
    try {
      return await runBroadcastAttempt(level, rung, message, messageEs, bypassStormGate, skipSip);
    } finally {
      releaseRetrySlotIfIdle();
    }
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
  // v1.48.0 — `message`/`messageEs` present ⇒ the retry replays THAT text (a
  // dedicated-path alarm: SoC ladder / runway, whose message is not derivable
  // from the condition spine). Absent ⇒ a condition broadcast; the retry
  // re-derives the message from the live alerts at fire time (v1.45.0 shape).
  let pendingSpokenRetry: {
    // v1.59.0 — the rung rides along: a retry replays the SAME severity tone as
    // the alarm whose speech failed. Storing only `level` would re-announce a
    // P1 with the generic red tone.
    level: ConditionLevel; rung: AlarmRung; failedAt: number;
    message?: string | null; messageEs?: string | null;
  } | null = null;
  // v1.48.0 — one scheduling seam for EVERY live alarm path. Saturday's live
  // incident: two starved-Piper chime-only alarms came through the DEDICATED
  // announce() path (SoC ladder), which never scheduled the v1.45.0 spoken
  // retry — the operator heard chimes and no speech ever followed. The tick
  // path and announce() now share this.
  const noteSpokenRenderFailure = (
    level: ConditionLevel,
    rung: AlarmRung,
    result: { ok: boolean; errors: string[]; verified?: boolean },
    message?: string | null,
    messageEs?: string | null,
  ): void => {
    if (result.ok || !result.errors.some((e) => e.startsWith('render:'))) return;
    pendingSpokenRetry = message !== undefined
      ? { level, rung, failedAt: Date.now(), message, messageEs: messageEs ?? null }
      : { level, rung, failedAt: Date.now() };
    log(`broadcast: spoken render failed — one retry scheduled in ${SPOKEN_RETRY_DELAY_MS / 1000}s`);
  };

  let broadcastChain: Promise<unknown> = Promise.resolve();
  // v1.48.0 — count of REAL audible broadcasts enqueued and not yet settled.
  // The terminator pre-warm reads this to yield: any pre-warm chain link that
  // finds a real broadcast pending becomes an instant no-op, so an alarm never
  // waits behind more than ONE short pre-warm render.
  let realAudibleInFlight = 0;
  const runBroadcast = (
    level: ConditionLevel,
    rung: AlarmRung,
    message: string | null,
    bypassStormGate = false,
    messageEs: string | null = null,
    skipSip = false, // v1.25.0 — forwarded to runBroadcastInner; set by deferred MA retries.
    // v1.186.0 — the default is the kind that arms the least: announce() (a dedicated
    // announcement) passes nothing, and a caller that forgets to say what it is must not be
    // able to arm the condition gates or mark the condition record heard.
    kind: BroadcastKind = 'dedicated',
  ): Promise<{ ok: boolean; errors: string[]; verified?: boolean }> => {
    realAudibleInFlight++;
    const run = () => runBroadcastInner(level, rung, message, messageEs, bypassStormGate, skipSip, kind);
    const p = broadcastChain.then(run, run);
    broadcastChain = p.catch(() => undefined);
    void p.then(() => { realAudibleInFlight--; }, () => { realAudibleInFlight--; });
    return p;
  };

  // v1.48.0 — boot-time terminator pre-warm, SERIALIZED through the broadcast
  // single-flight (unserialized Piper traffic is the documented crash vector,
  // and audioRenderer's residentVoice tracking assumes serialized renders).
  // Each entry is its OWN chain link so a real broadcast enqueued mid-pre-warm
  // waits behind at most one short render; later links see it pending and
  // no-op. Entries are ordered Spanish → English so Piper is left holding the
  // PRIMARY voice. On a warmed install every link is a single file stat.
  // Failures halt the remaining entries (never fire fresh requests at a server
  // that just failed — the alarm path renders on demand as before).
  const prewarmTimer: NodeJS.Timeout = setTimeout(() => {
    if (stopped || !cfg.enabled || !cfg.endOfMessage || cfg.wyomingHost.length === 0) return;
    const entries: Array<{ lang: 'en' | 'es'; voice?: string; phrase: string }> = [];
    if (cfg.bilingual && cfg.secondLangVoice.length > 0) {
      entries.push({ lang: 'es', voice: cfg.secondLangVoice, phrase: cfg.endOfMessagePhraseEs || cfg.endOfMessagePhrase });
    }
    entries.push({ lang: 'en', voice: cfg.wyomingVoice ?? undefined, phrase: cfg.endOfMessagePhrase });
    let halted = false;
    for (const entry of entries) {
      const job = async () => {
        if (stopped || halted) return;
        if (realAudibleInFlight > 0) {
          halted = true;
          log('broadcast: terminator pre-warm yielded — a real broadcast is pending (remaining entries render on demand)');
          return;
        }
        try {
          const r = await prewarmTerminatorCache({
            cacheDir: opts.cacheDir, host: cfg.wyomingHost, port: cfg.wyomingPort, entries: [entry], log,
          });
          if (r.failed > 0) halted = true;
        } catch (e) {
          halted = true;
          log(`broadcast: terminator pre-warm errored (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      const p = broadcastChain.then(job, job);
      broadcastChain = p.catch(() => undefined);
    }
  }, 20_000);

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
  /** v1.173.1 — when the current fresh boot-window yellow was first seen (holdBootYellow). */
  let warmupYellowSinceMs: number | null = null;
  /** v1.173.2 — the held-yellow log line has been written for this episode. */
  let warmupYellowLogged = false;
  /**
   * v1.187.1 — the boot holds' OUTCOME. The hold lines named nothing, and a held condition that
   * cleared inside its hold was dropped without a line (2026-09-30 06:32:58: a boot yellow was held,
   * the level went back to green, and only missing lines showed it was never spoken). Each hold now
   * names what it holds, and a hold that ends below its level says so once, with what it held. A
   * commit (adoptLevel) ends a pending hold silently: the condition was adopted — spoken, or
   * silenced by a gate that logs its own line — not dropped.
   */
  let bootYellowHold: { sinceMs: number; fps: Set<string> } | null = null;
  let bootRedHold: { fps: string[] } | null = null;
  /** v1.186.0 — the post-warm-up condition-record reconciliation has run (once per boot). */
  let conditionReconciled = false;
  /** v1.187.0 — the de-escalation dwell's clocks (deescalationDue): since when the observed
   *  condition has been continuously below red, and continuously green. They run every tick. */
  let belowRedSinceMs: number | null = null;
  let greenSinceMs: number | null = null;
  /** v1.187.0 — a downward move being held, for the once-per-episode log lines. `heard` is the
   *  condition record's heard flag when the hold began (see the hold branch in the tick).
   *  v1.187.3 (log review) — `soundedHeldInWarmup`: a sounded critical held this hold inside the
   *  warm-up (soundedCriticalHeld), so its green's recovery is decided once, even past the warm-up
   *  (see recoveryCandidate in the tick). */
  let deescalationHold: { from: ConditionLevel; sinceMs: number; heard: boolean; soundedHeldInWarmup: boolean } | null = null;
  /** v1.187.3 (review) — a continuous green under a heard restart baseline that has stood its dwell
   *  inside the warm-up but not on a settled alert set (isRestartRecovery): held for its recovery,
   *  since this time. Cleared whenever the green clock is (the green ended, or a sounded critical
   *  is held), so it describes the green standing now; once that green commits, no green
   *  transition follows it. */
  let recoveryHoldSinceMs: number | null = null;
  /**
   * v1.187.0 — a condition transition the same-level storm gate refused, waiting to be
   * re-presented. Nothing ever retried one: the tick had already committed the level, so the
   * gate's refusal was final. On 2026-09-29 15:41:10 the green that followed the 15:38 red was
   * refused 67 s after the red ended, and nothing was spoken again — the last words in the house
   * were a critical that had cleared. It is now re-presented ONCE, when the gap expires, through
   * the tick's own gates (still the same level, broadcasts enabled, the all-clear speech gate,
   * minimum severity, quiet hours). Any newer commit supersedes it (adoptLevel), and a
   * re-present never arms another. Two kinds are deferred:
   *   • a DE-ESCALATION (a level below lastConditionPlayedLevel) — `fresh` is null: the level
   *     itself is the news (the last words must not stay a condition that has cleared);
   *   • v1.187.0 (review) — a SAME-level transition that carried something NEW to the audible
   *     (a new warning inside a held yellow→green, a different critical while red): `fresh` lists
   *     the identities that were new at that commit, and the re-present is spoken only while one
   *     of them is still counted. Before, such a warning was refused and — being recorded in
   *     prevWarnFps — every later flicker of it was absorbed by the dwell, so it was never voiced.
   * `waitLogged`: the one "waits" log line while a lower level stands its dwell.
   */
  let deferredCondition: {
    level: ConditionLevel; dueAtMs: number; fresh: readonly string[] | null; waitLogged: boolean;
  } | null = null;

  /**
   * v1.187.0 — end a held de-escalation that did NOT commit: the level is back up. When it is back
   * at the committed level with nothing new (`restoreHeard`), the heard flag the hold demoted is
   * restored — the household heard this level and nothing else has been committed since, so a
   * flicker the dwell absorbed does not cost the v0.58.0 restart continuation its baseline.
   */
  const endDeescalationHold = (level: ConditionLevel, how: string, restoreHeard: boolean): void => {
    const h = deescalationHold;
    if (h == null) return;
    deescalationHold = null;
    log(`broadcast: held de-escalation from ${h.from} abandoned after ${Math.round((Date.now() - h.sinceMs) / 1000)} s — the condition is ${level}${how}`);
    if (restoreHeard && h.heard && conditionLevel === h.from && !conditionSpoken) {
      conditionSpoken = true;
      persistStatus();
    }
  };

  /**
   * v1.187.0 — speak a condition the tick has committed: the transition itself, or the one
   * re-present of a storm-gated condition. Both take the repeat-warning gate, the same status
   * record and the same red-replay bookkeeping. `mayDefer` is false on the re-present, so a
   * re-present that is refused again is not re-armed (bounded: one). `ids.fresh`: the counted
   * identities at this level that were NOT counted at the previous commit (empty on a re-present).
   */
  const speakCondition = async (
    level: ConditionLevel,
    rung: AlarmRung,
    alerts: Alert[],
    ids: {
      voicedFingerprint: string | null; criticalFingerprints: string[]; warningFingerprints: string[];
      fresh: readonly string[];
    },
    mayDefer: boolean,
  ): Promise<void> => {
    const { voicedFingerprint, criticalFingerprints } = ids;
    // v1.187.0 — the repeat-warning gate (sameWarningRepeat), on the identity of what would be
    // SAID: pickPrimaryAlert is the one alert buildAlertMessage names.
    const named = level === 'yellow' ? pickPrimaryAlert(alerts, 'yellow') : null;
    const warning = level === 'yellow'
      ? { voicedFp: named == null ? null : alertFingerprint(named), rung, warnFps: ids.warningFingerprints }
      : null;
    if (warning != null && sameWarningRepeat(warning, lastVoicedWarning, Date.now())) {
      stormSuppressedCount += 1;
      noteSuppression(level, 'condition', 'same warning already voiced');
      log(`broadcast: yellow suppressed — the same warning (${describeFingerprint(warning.voicedFp ?? '')}) was voiced ${Math.round((Date.now() - (lastVoicedWarning?.atMs ?? 0)) / 1000)}s ago and no green or red has been voiced since (storm gate)`);
      return;
    }
    const message = messageFor(level, alerts);
    const messageEs = messageEsFor(level, alerts); // v0.62.0 — Spanish second pass
    const result = await runBroadcast(level, rung, message, false, messageEs, false, 'condition');
    const doneAt = Date.now();
    // v1.187.0 — a storm-gate suppression rendered and dispatched nothing: it is recorded apart
    // (noteSuppression, in the gate) and does not become the last broadcast.
    if (!isStormSuppression(result)) {
      lastBroadcastAt = doneAt;
      lastLevel = level; lastBroadcastKind = 'condition';
      lastOutcome = result.ok ? 'success' : 'partial';
      lastErrors = result.errors;
    }
    // v1.64.0 — record WHICH critical was actually SPOKEN and WHEN, so the next
    // boot's replay gate has evidence. Only on a VERIFIED-successful dispatch,
    // mirroring the bootBaselineLevel rule: a partial/failed broadcast means the
    // operator may not have heard it, and un-heard is indistinguishable from
    // never-said — it must not buy 30 minutes of silence. Every other red path
    // (deferred retry, spoken retry, the dedicated SoC/runway announcers)
    // deliberately does NOT record: not recording only ever costs one extra
    // klaxon, which is the safe direction.
    //
    // ★★★ `voicedFingerprint` and NOT the whole critical set: this broadcast
    // named exactly ONE alert aloud (pickPrimaryAlert's choice). Filing the
    // others as "announced" would let a critical nobody ever heard be muted on
    // the next boot. criticalFingerprints rides along as context only — the gate
    // uses it solely to REQUIRE more announcements (something new appeared),
    // never to justify one less.
    // v1.122.0 — VERIFIED, not merely ok. A timed-out dispatch returns ok:true
    // (so it is not retried) but verified:false, because "delivery UNKNOWN" is
    // exactly the state in which nobody may have heard it. Granting it
    // verification credit would let one unlucky timeout suppress a standing
    // critical's klaxon replay — and on this plant standing faults keep the same
    // fingerprint for weeks. The intent is stated verbatim a few lines above:
    // "a partial/failed broadcast means the operator may not have heard it, and
    // un-heard is indistinguishable from never-said".
    const deliveryVerified = result.ok && result.verified !== false;
    if (isRecordableRedAnnounce(level, deliveryVerified) && voicedFingerprint != null) {
      redReplayGate.noteRedAnnounced({ voicedFingerprint, activeFingerprints: criticalFingerprints, nowMs: doneAt });
    } else if (deliveryVerified && level !== 'red') {
      // A verified yellow/green played AFTER a recorded red: the next red is an
      // ESCALATION over it and must never be suppressed. Demote the recorded
      // level so the carve-out sees it (green additionally wipes the state when
      // adoptLevel commits it — this covers the yellow case).
      redReplayGate.notePlayedBelowRed(level);
    }
    // v1.187.0 — a yellow that reached the speakers (verified or delivery-unknown) is what the
    // repeat-warning gate remembers. A failed or chime-only yellow is not: it was not heard.
    if (warning != null && warning.voicedFp != null && result.ok) {
      lastVoicedWarning = { voicedFp: warning.voicedFp, rung, warnFps: [...warning.warnFps], atMs: doneAt };
    }
    // v1.45.0 — a render failure (chime-only fallback or full skip) earns ONE
    // spoken retry after the stall window.
    noteSpokenRenderFailure(level, rung, result);
    // v1.187.0 — a transition refused by the same-level gap is re-presented once when the gap
    // expires (see deferredCondition): a DE-ESCALATION always, and — v1.187.0 (review) — a
    // same-level one that carried something new (`ids.fresh`). A same-level refusal with nothing
    // new is left as it was (the household heard this level moments ago); so is the identical-
    // message gate's (the last words were these words).
    if (
      mayDefer
      && result.errors[0] === 'suppressed: same-or-lower level within gap'
      && lastConditionPlayedLevel != null
    ) {
      const lower = LEVEL_RANK[level] < LEVEL_RANK[lastConditionPlayedLevel];
      if (lower || ids.fresh.length > 0) {
        deferredCondition = {
          level, dueAtMs: lastConditionPlayedAt + SAME_LEVEL_GAP_MS, fresh: lower ? null : [...ids.fresh], waitLogged: false,
        };
        const what = lower ? '' : ` and what was new to it (${ids.fresh.map(describeFingerprint).join('; ')}) is still counted`;
        log(`broadcast: ${level} will be re-presented once the storm gate's ${Math.round(SAME_LEVEL_GAP_MS / 1000)} s gap expires (in ${Math.max(0, Math.round((deferredCondition.dueAtMs - doneAt) / 1000))} s), if the condition is still ${level}${what}`);
      }
    }
  };

  const tick = async () => {
    if (stopped) return;
    cfg = loadBroadcastConfig();
    // v0.11.0 — drop alerts whose ISA priority has been silenced on the Alert
    // Settings page BEFORE counting crit/warn, so a silenced priority never
    // raises the condition level (and thus never triggers a chime/broadcast).
    // The alerts stay in snapshot.alerts and remain visible in the UI — we only
    // gate the audible annunciation here.
    // v1.174.0 — and drop a cell-imbalance warning that has not yet stood for its hold
    // (heldForImbalanceConfirm). Dropping it HERE, from the array that feeds both
    // conditionFromAlerts and messageFor, is what keeps a 6-minute excursion from both
    // raising the condition and being voiced; it stays on the card and in the push.
    const tickNow = Date.now();
    // v1.187.0 — and an audible:false alert, for the same reason. The chain is speakableAlerts,
    // pure and exported so the array both consumers see is pinned by behavioural tests.
    const alerts = speakableAlerts((store.get().alerts ?? []) as Alert[], tickNow, getAlertOnset);
    const { level, crit, rung, criticalIds, criticalFingerprints, warningFingerprints } = conditionFromAlerts(alerts);
    // v1.64.0 — the fingerprint of the ONE critical this tick would actually SAY
    // OUT LOUD. buildAlertMessage voices pickPrimaryAlert's choice and nothing
    // else, so that choice — computed from the SAME `alerts` array messageFor()
    // will be handed — is what the replay gate must compare. Null when nothing
    // would be named, which the gate treats as "cannot prove sameness" ⇒ announce.
    const voicedFingerprint = voicedRedFingerprint(level, alerts);
    // v1.187.0 — what a commit on this tick records (adoptLevel → newCrit / newWarn).
    const ids = { crit: criticalFingerprints, warn: warningFingerprints };
    // v1.187.0 — the de-escalation dwell's clocks run on EVERY tick, whatever else the tick
    // does, so "has stood for 3 minutes" means 3 minutes of observations, not of commits.
    // v1.187.0 (log review) — a critical that sounded and is now held by a bounded cell-spread
    // mute, or a cell-spread critical that sounded and is between two of its readings, reads as
    // red to these clocks (soundedCriticalHeld): held, not cleared. No move below red, nor to
    // green, commits until it clears (then the lower level stands its full dwell) or annunciates
    // again.
    const critHeld = soundedCriticalHeld(alerts, soundedCritFps, tickNow);
    // …and a critical counted while the committed level is red is recorded as sounded on every
    // such tick, not only at a red commit: one that cleared and came back loud inside a hold is a
    // flicker the hold absorbs, which commits nothing.
    if (level === 'red' && prevLevel === 'red') for (const f of criticalFingerprints) soundedCritFps.set(f, tickNow);
    // v1.187.3 (log review, LOW) — a restored critical present again (muted or loud) has a new
    // last-present time: the disk takes it from the record from now on (soundedCritRestoredAt).
    if (soundedCritRestoredAt.size > 0) {
      const presentCrit = new Set(alerts.filter((a) => a.severity === 'critical').map((a) => alertFingerprint(a)));
      for (const f of [...soundedCritRestoredAt.keys()]) if (presentCrit.has(f)) soundedCritRestoredAt.delete(f);
    }
    // v1.187.3 (log review) — and the record survives a restart (restoreSoundedCriticals): written
    // when its set changes, and while it holds anything at most every SOUNDED_CRIT_PERSIST_EVERY_MS.
    // Only the entries that can hold after a restart count (soundedCritKept).
    if (soundedCritKeys() !== soundedCritWritten.keys
      || (soundedCritKept().length > 0 && tickNow - soundedCritWritten.atMs >= SOUNDED_CRIT_PERSIST_EVERY_MS)) persistStatus();
    if (level === 'red' || critHeld) belowRedSinceMs = null;
    else if (belowRedSinceMs == null) belowRedSinceMs = tickNow;
    if (level !== 'green' || critHeld) greenSinceMs = null;
    else if (greenSinceMs == null) greenSinceMs = tickNow;
    if (greenSinceMs == null) recoveryHoldSinceMs = null;
    if (firstTick) {
      firstTick = false;
      // ★ NOT adoptLevel(): a boot-time green is almost always "the alert store
      // has not populated yet", not an all-clear. See adoptLevel's docstring.
      if (level === 'green') {
        prevLevel = level;
        prevCrit = crit;
        return;
      }
      // v1.186.0 — a NON-green first tick is a condition standing at boot, and is never joined
      // silently: it is treated as a transition from green, on THIS tick, through the boot gates
      // below (restart continuation with the heard baseline, the boot yellow hold, holdBootRed,
      // the red replay gate). Joining it made every later tick read "no transition", so a
      // condition unheard before the restart was never spoken (nor pushed: the alert monitor
      // seeds tick-1 alerts), and the next boot repeated it.
      prevLevel = 'green';
      prevCrit = 0;
      log(`broadcast: ${level} standing at the first tick — routed through the boot gates, not joined silently`);
    }
    // v1.186.0 — the first tick joins the current level SILENTLY and does not write the
    // condition record (an unpopulated store reads green). Once the warm-up window has passed,
    // prevLevel is the settled condition: if nothing since boot has refreshed the record, bring
    // it in line, unheard. Otherwise a condition that cleared while the add-on was down would
    // leave its old level standing as the baseline for every later restart.
    if (!conditionReconciled && Date.now() - bootMs >= BROADCAST_BOOT_WARMUP_MS) {
      conditionReconciled = true;
      if (prevLevel != null && conditionLevel !== prevLevel) {
        conditionLevel = prevLevel;
        conditionSpoken = false;
        conditionAt = Date.now();
        persistStatus();
      }
    }
    // v1.45.0 — due spoken retry (see pendingSpokenRetry). Runs only when no
    // transition work is in flight; re-checks that the condition level is
    // unchanged (a new transition supersedes the retry naturally), that
    // broadcasts are still enabled, and quiet hours — the same gate the
    // original attempt faced. Bypasses the storm gate: an intentionally
    // identical message is the whole point of the retry.
    if (pendingSpokenRetry && !tickInFlight && Date.now() - pendingSpokenRetry.failedAt >= SPOKEN_RETRY_DELAY_MS) {
      const want = pendingSpokenRetry.level;
      const wantRung = pendingSpokenRetry.rung;
      // v1.48.0 — a dedicated-path retry carries its own text and replays it
      // verbatim; the condition-level match below only applies to condition
      // broadcasts (a SoC-ladder alarm is EXCLUDED from the condition spine,
      // so `level === want` would wrongly drop it, or worse, re-derivation
      // would speak a DIFFERENT alarm's message).
      const stored = pendingSpokenRetry.message !== undefined
        ? { message: pendingSpokenRetry.message, messageEs: pendingSpokenRetry.messageEs ?? null }
        : null;
      pendingSpokenRetry = null;
      const levelOk = stored != null || level === want;
      if (levelOk && cfg.enabled && !(inQuiet() && !(want === 'red' && cfg.criticalBreakThrough))) {
        tickInFlight = true;
        try {
          log(`broadcast: spoken retry after render failure → ${want}${stored ? ' (dedicated-path message replay)' : ''}`);
          const message = stored ? stored.message : messageFor(level, alerts);
          const messageEs = stored ? stored.messageEs : messageEsFor(level, alerts);
          // v1.186.0 — a dedicated-path replay stays dedicated; a condition retry is condition.
          const result = await runBroadcast(want, wantRung, message, true, messageEs, false, stored ? 'dedicated' : 'condition');
          lastBroadcastAt = Date.now();
          lastLevel = level; lastBroadcastKind = stored ? 'dedicated' : 'condition';
          lastOutcome = result.ok ? 'success' : 'partial';
          lastErrors = result.errors;
        } finally {
          tickInFlight = false;
        }
        return;
      }
      log(`broadcast: spoken retry dropped — level moved ${want} → ${level} or gated`);
    }
    // v1.187.0 — the ONE re-present of a transition the same-level storm gate refused (see
    // deferredCondition). Due once the gap has expired; spoken only if the condition is still
    // that level, what was new to it (a same-level deferral's `fresh`) is still counted, and the
    // tick's own gates for it still pass — the all-clear speech gate, the minimum severity, quiet
    // hours (a red breaks through them only as the tick's own red does). A HIGHER level drops it:
    // that is a transition the code below announces.
    // v1.187.0 (review) — a LOWER level does NOT drop it. A lower level is either being held by
    // the de-escalation dwell or committing on this very tick; dropping the deferral there lost a
    // warning nobody had heard whenever the lower level failed to stand the full dwell — the
    // level returned to the deferred one, a flicker the dwell absorbs, so no transition spoke it,
    // and the last words stayed a critical that had cleared. It waits: the lower level's commit
    // supersedes it (adoptLevel), and a return to the deferred level re-presents it on that tick.
    if (deferredCondition != null && !tickInFlight && Date.now() >= deferredCondition.dueAtMs) {
      const held = deferredCondition;
      if (LEVEL_RANK[level] < LEVEL_RANK[held.level]) {
        if (!held.waitLogged) {
          held.waitLogged = true;
          log(`broadcast: the storm-gated ${held.level} waits — the condition is ${level} now, standing its de-escalation dwell; re-presented if it returns to ${held.level}, superseded if ${level} commits`);
        }
      } else {
        deferredCondition = null;
        const counted = held.level === 'red' ? criticalFingerprints : warningFingerprints;
        const notNow =
          level !== held.level ? `the condition is ${level} now`
          : held.fresh != null && !held.fresh.some((f) => counted.includes(f)) ? 'what was new to it is no longer counted'
          : !cfg.enabled ? 'broadcasts are disabled'
          : held.level === 'green' && allClearSpeechBlocked(alerts) ? 'a critical alert is still active'
          : held.level === 'yellow' && cfg.minSeverity === 'critical' ? 'yellow is below the minimum severity'
          : inQuiet() && !(held.level === 'red' && cfg.criticalBreakThrough) ? 'quiet hours' : null;
        if (notNow != null) {
          log(`broadcast: the storm-gated ${held.level} is not re-presented — ${notNow}`);
        } else {
          // The condition is back at the committed level: a held de-escalation below it (a lower
          // level that did not stand its dwell) is over.
          endDeescalationHold(level, ' again — the storm-gated condition is re-presented', true);
          tickInFlight = true;
          try {
            log(`broadcast: re-presenting the ${held.level} the storm gate refused — the gap has expired and the condition is still ${held.level}`);
            await speakCondition(held.level, rung, alerts, { voicedFingerprint, criticalFingerprints, warningFingerprints, fresh: [] }, false);
          } finally {
            tickInFlight = false;
          }
          return;
        }
      }
    }
    // v1.187.0 — prevLevel is set by the first tick above, so it is never null here.
    const committed: ConditionLevel = prevLevel ?? 'green';
    const downward = LEVEL_RANK[level] < LEVEL_RANK[committed];
    // v1.187.0 — NEW criticals by IDENTITY as well as by count. The count alone missed a
    // different critical replacing a cleared one at the same count — and with the de-escalation
    // dwell holding prevLevel at red while a cleared critical is confirmed, that is exactly the
    // case a count-keyed newCrit would silence. The count term stays: it can only add alarms.
    const newCrit = level === 'red' && (crit > prevCrit || hasNewIdentity(criticalFingerprints, prevCritFps));
    // v1.187.0 — and a NEW warning while a de-escalation is held (a yellow below a held red, or a
    // yellow returning within a held yellow→green) is a new condition, spoken at once exactly as
    // it was before the dwell existed. A warning that was counted at the last commit is the
    // flicker the dwell absorbs.
    const newWarn = level === 'yellow' && (downward || deescalationHold != null)
      && hasNewIdentity(warningFingerprints, prevWarnFps);
    // v1.187.0 (review) — the identities at this level that were NOT counted at the last commit,
    // read before adoptLevel records the new set. A same-level storm-gate refusal of a transition
    // carrying any of them is re-presented when the gap expires (see deferredCondition).
    const fresh = level === 'red' ? criticalFingerprints.filter((f) => !prevCritFps.has(f))
      : level === 'yellow' ? warningFingerprints.filter((f) => !prevWarnFps.has(f))
      : [];
    const transitioned = level !== prevLevel || newWarn;
    // v1.187.0 (log review) — a NEW warning below a sounded cell-spread critical that is only HELD
    // (soundedCriticalHeld) is spoken at once, like any new warning, but the committed level STAYS
    // red: committing yellow there reset the red episode (prevCritFps), so the held critical's next
    // loud reading counted as a new red and could sound the klaxon again. Kept red, that reading is
    // the flicker the hold absorbs, and the lower level commits only once the critical has cleared
    // and the dwell has run. Only below a committed red (the only level a sounded critical holds).
    const keepRed = critHeld && level !== 'red' && prevLevel === 'red';
    // v0.87.0 — clear the boot phantom-red latch whenever the level is not red
    // (phantom cleared or genuine de-escalation), so a later red in the warm-up
    // window is re-confirmed across a tick rather than fast-tracked.
    if (level !== 'red') warmupRedSeen = false;
    if (level !== 'yellow') { warmupYellowSinceMs = null; warmupYellowLogged = false; }
    // v1.187.1 — a red held for its boot confirmation and gone on the next tick: never spoken.
    if (level !== 'red' && bootRedHold != null) {
      log(`broadcast: boot red dropped — the level fell to ${level} inside its one-tick confirmation; not spoken (${bootRedHold.fps.map(describeFingerprint).join('; ')})`);
      bootRedHold = null;
    }
    // v1.187.1 — a boot yellow that cleared inside its hold: never spoken. A rise to red is not a
    // drop (red logs its own hold and transition), so only a fall to green is said.
    if (level !== 'yellow' && bootYellowHold != null) {
      if (level === 'green') log(`broadcast: boot yellow dropped after ${Math.round((Date.now() - bootYellowHold.sinceMs) / 1000)} s — cleared inside the hold, not spoken (${[...bootYellowHold.fps].map(describeFingerprint).join('; ')})`);
      bootYellowHold = null;
    }
    // v1.187.3 (review) — a green below a heard restart baseline, inside the warm-up, commits only
    // as a RECOVERY (isRestartRecovery): once it has stood the dwell on a SETTLED alert set, measured
    // from the later of the green and the alert monitor's settled stamp. Until then it is held like
    // any de-escalation below, past its own dwell if need be. Adopted as a continuation when it had
    // stood only the plain dwell, it could never be spoken; spoken then, a critical still inside its
    // restarted debounce re-published seconds later ("All clear", then the klaxon).
    const inWarmup = Date.now() - bootMs < BROADCAST_BOOT_WARMUP_MS;
    // v1.187.3 (log review) — a green held inside the warm-up by a sounded critical
    // (soundedCriticalHeld: muted, or a cell-spread critical between readings; marked on the hold
    // below) has its recovery decided ONCE, even when its dwell ends after the warm-up. The green
    // clock starts only when the critical releases it: a restored absent cell-spread critical holds
    // 7 min from the boot, so its green stood the 3-min dwell exactly as the 10-min warm-up ended,
    // always took the late-green path (an ordinary transition) and was spoken with the alert set
    // never settled, where the same restart without the record adopted it silently. On its first
    // due tick it is a recovery (settled for the dwell: spoken) or held, and adopted silently on
    // the next tick (recoveryHoldSinceMs is then set).
    const recoveryCandidate = level === 'green' && continuationBaseline != null
      && (inWarmup || (deescalationHold?.soundedHeldInWarmup === true && recoveryHoldSinceMs == null));
    const settledSinceMs = recoveryCandidate ? alertSetSettledSince() : null;
    const recovery = recoveryCandidate
      && isRestartRecovery(continuationBaseline, level, greenSinceMs, Date.now(), settledSinceMs);
    const lowerDue = deescalationDue(level, belowRedSinceMs, greenSinceMs, Date.now());
    // v1.187.0 — the de-escalation dwell (deescalationDue). A downward move is held — prevLevel
    // NOT advanced, nothing adopted or spoken — until the lower level has stood for
    // CONDITION_CLEAR_DWELL_MS. A flicker back up inside it is then no transition at all.
    if (downward && !newWarn && (!lowerDue || (recoveryCandidate && !recovery))) {
      if (deescalationHold == null) {
        deescalationHold = { from: committed, sinceMs: Date.now(), heard: conditionSpoken, soundedHeldInWarmup: false };
        // v1.187.0 (review) — the condition record (the next boot's restart baseline) follows
        // the COMMITTED level, and the committed level is no longer what the house observes. A
        // restart inside the dwell would otherwise boot on "red, heard" and swallow a standing
        // yellow as a continuation of it. Demoted to unheard for the hold — which only ever
        // makes a restart speak more — and restored if the level comes back (endDeescalationHold).
        if (conditionSpoken) {
          conditionSpoken = false;
          persistStatus();
        }
        log(`broadcast: ${committed} → ${level} held — a lower condition is committed only after it has stood ${Math.round(CONDITION_CLEAR_DWELL_MS / 1000)} s (flicker guard); nothing is spoken meanwhile${critHeld ? `. A cell-spread critical that sounded is held, not cleared (muted by a bounded cell-spread mute, or between two of its readings): the hold lasts until it annunciates again, or clears and stays gone ${Math.round(SOUNDED_VDIFF_ABSENT_HOLD_MS / 60_000)} minutes` : ''}`);
      }
      // v1.187.3 (log review) — a sounded critical holds this hold inside the warm-up: its green's
      // recovery is decided once, even past the warm-up (recoveryCandidate above). Set on every such
      // tick, the hold's first included; a hold that ends (the level back up, or a commit) forgets it.
      if (critHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true;
      // v1.187.3 (review) — past its own dwell, a green is held only for its recovery: said once.
      if (lowerDue && recoveryHoldSinceMs == null) {
        recoveryHoldSinceMs = Date.now();
        const why = settledSinceMs == null
          ? 'the alert set is not settled (the store not hydrated, a feed\'s alerts not yet in the set, the boot onset debounces still running, or an onset clock withholding a fault)'
          : `the alert set has been settled only ${Math.round((Date.now() - settledSinceMs) / 1000)} s`;
        log(`broadcast: green has stood ${Math.round(CONDITION_CLEAR_DWELL_MS / 1000)} s but is held, not adopted — ${why}. ${inWarmup
          ? `It is announced as a recovery from the pre-restart ${continuationBaseline} once it has stood ${Math.round(CONDITION_CLEAR_DWELL_MS / 1000)} s on a settled set, or adopted silently as a continuation if the warm-up ends first`
          : `A sounded critical held it inside the warm-up, which has ended: it is adopted silently as a continuation of the pre-restart ${continuationBaseline}`}`);
      }
      // v1.187.0 (review) — GREEN observed under a held level destroys the red-replay evidence
      // NOW, not when the green commits. The evidence is read only at boot: kept through the hold,
      // a restart inside it booted on it (the boot green is joined silently and never wipes), and
      // the same critical re-raising inside the warm-up was muted as an "already announced
      // standing fault" where a committed green would have made it a new event. Clearing early
      // costs at most one extra klaxon after a restart — the direction redReplayGate names safe.
      // In-session flicker absorption runs on prevLevel / prevCritFps and is unaffected.
      if (level === 'green' && redReplayGate.state() != null) {
        redReplayGate.noteConditionGreen();
        log(`broadcast: green observed under a held ${committed} — the red-replay evidence is cleared now (a restart inside the dwell must treat the next red as new)`);
      }
      return;
    }
    // A hold that ends with the level back up is over. With a NEW warning it is not cleared here:
    // that transition may itself wait (the boot yellow hold, a broadcast in flight), and it must
    // still read as new on the next tick — adoptLevel clears the hold when it commits.
    if (!downward && !newWarn && deescalationHold != null) {
      const back = level === deescalationHold.from && !newCrit;
      const how = newCrit ? ' with a new critical' : back ? ' again (flicker absorbed, nothing spoken)' : '';
      endDeescalationHold(level, how, back);
    }
    // v0.58.0 — within the post-restart warm-up window, a condition that was
    // already active (and successfully broadcast) before the restart re-appears as
    // a "rise" once the analytics/learned alerts re-warm. Don't re-speak it aloud;
    // adopt the level silently. A genuine escalation above the pre-restart baseline
    // (e.g. yellow→red across the restart) still passes through and broadcasts.
    // v1.187.3 — …unless it is a RECOVERY (isRestartRecovery, decided above): a green that has
    // stood the de-escalation dwell on a settled alert set. It goes on as an ordinary transition
    // below (the all-clear speech gate, quiet hours and the storm gates still apply), and the
    // baseline ends with it, so it is announced once and a later warning in the warm-up is news.
    if (transitioned && recovery) {
      log(`broadcast: green has stood ${Math.round((Date.now() - Math.max(greenSinceMs ?? 0, settledSinceMs ?? 0)) / 1000)} s on a settled alert set — a recovery, not a continuation of the pre-restart ${continuationBaseline}; announced as a transition`);
      continuationBaseline = null;
    } else if (transitioned && level === 'green' && recoveryHoldSinceMs != null && !inWarmup) {
      // v1.187.3 (review) — the warm-up ended with the green still held for a recovery it did not
      // earn: adopted as the continuation it was before v1.187.3, in silence (fail-quiet — a green
      // read from an unsettled set may be a fault still withheld).
      log(`broadcast: the warm-up ended before the green had stood ${Math.round(CONDITION_CLEAR_DWELL_MS / 1000)} s on a settled alert set — adopted silently as a continuation of the pre-restart ${continuationBaseline}, not announced`);
      adoptLevel(level, crit, ids, true);
      return;
    }
    if (transitioned && isRestartContinuation(continuationBaseline, level, Date.now() - bootMs)) {
      // v1.187.3 (review) — never a green: inside the warm-up a green under the baseline is held
      // until it is a recovery (above), and past it this predicate is false.
      log(`broadcast: ${level} matches pre-restart advisory — suppressing duplicate (restart continuation)`);
      // v1.186.0 — heard before the restart (the baseline says so); a kept red is not.
      adoptLevel(keepRed ? 'red' : level, keepRed ? prevCrit : crit, ids, !keepRed);
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
    // v1.173.1 — a fresh YELLOW inside the warm-up window must persist BOOT_YELLOW_CONFIRM_MS
    // before it is spoken (boot transients: off-panel mute lag, stale-until-first-read).
    // prevLevel is not advanced, so a persisting yellow re-presents each tick and fires once
    // confirmed; one that clears is never spoken.
    if (level === 'yellow' && transitioned && Date.now() - bootMs < BROADCAST_BOOT_WARMUP_MS && warmupYellowSinceMs == null) {
      warmupYellowSinceMs = Date.now();
    }
    if (holdBootYellow(level === 'yellow' && transitioned, Date.now() - bootMs, warmupYellowSinceMs, Date.now())) {
      // v1.187.1 — every warning the hold sees, for its outcome line.
      if (bootYellowHold == null) bootYellowHold = { sinceMs: warmupYellowSinceMs ?? Date.now(), fps: new Set() };
      for (const f of warningFingerprints) bootYellowHold.fps.add(f);
      // v1.173.2 — one line per held episode, not one per 10 s tick.
      if (!warmupYellowLogged) {
        warmupYellowLogged = true;
        log(`broadcast: yellow held for boot confirmation (up to ${Math.round(BOOT_YELLOW_CONFIRM_MS / 1000)} s) — startup transients clear on their own (${warningFingerprints.map(describeFingerprint).join('; ')})`);
      }
      return;
    }
    if (holdBootRed(level === 'red' && (transitioned || newCrit), Date.now() - bootMs, warmupRedSeen)) {
      warmupRedSeen = true;
      bootRedHold = { fps: [...criticalFingerprints] };
      log(`broadcast: red held one tick for boot confirmation (warm-up phantom guard) (${criticalFingerprints.map(describeFingerprint).join('; ')})`);
      return;
    }
    // v1.64.0 — post-restart RED replay gate. Placed AFTER holdBootRed so only a
    // CONFIRMED red (one that survived the phantom-grace tick) is ever evaluated
    // here; a one-tick populate phantom is still filtered upstream exactly as
    // before, and can never be adopted as prevLevel by this branch.
    //
    // Suppresses ONLY when: inside the warm-up window, this red is not an
    // ESCALATION over the last level actually played, the critical that would be
    // SPOKEN now is the very one that was spoken then (same fingerprint — id +
    // title + error code, NOT the bare id), no other critical has appeared
    // alongside it, and that announcement was < 30 min ago. Anything else fires
    // immediately at any age. See redReplayGate.ts.
    if (redReplayGate.shouldSuppress({ observed: level, voicedFingerprint, activeFingerprints: criticalFingerprints, msSinceBoot: Date.now() - bootMs, nowMs: Date.now() })) {
      log(`broadcast: red suppressed — this standing fault was already announced, and nothing about it has changed (${voicedFingerprint ? describeFingerprint(voicedFingerprint) : '?'}; active: ${criticalIds.join(', ')})`);
      adoptLevel(level, crit, ids, true); // v1.186.0 — a verified announcement of it is on record
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
    // v1.64.0 — via adoptLevel, so a committed GREEN clears the red-replay
    // evidence whether or not the all-clear is ultimately SPOKEN (disabled,
    // quiet hours, or the critical-still-active gate below all return after this
    // point — and in every one of them the condition genuinely reached green).
    // v1.187.0 (log review) — below a held sounded critical the red stays committed (keepRed);
    // the new warning is still spoken below, at its own level.
    adoptLevel(keepRed ? 'red' : level, keepRed ? prevCrit : crit, ids);
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
    if (level === 'green' && allClearSpeechBlocked(alerts)) {
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
      log(`broadcast: condition transition → ${level}${newCrit ? ' (new crit)' : newWarn ? ' (new warning)' : ''}${keepRed ? ' spoken; the committed condition stays red (a cell-spread critical that sounded is held)' : ''}, ${cfg.targets.length} target(s)`);
      pendingSpokenRetry = null; // a fresh transition supersedes any queued retry
      // v1.187.0 — the message, the storm gates, the status record and the red-replay
      // bookkeeping live in speakCondition, shared with the storm-gated re-present.
      await speakCondition(level, rung, alerts, { voicedFingerprint, criticalFingerprints, warningFingerprints, fresh }, true);
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

  const tickInterval = setInterval(() => { tick().catch((e) => log(`broadcast: tick failed: ${e?.message ?? e}`)); }, opts.tickMs ?? 10_000);
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
      // v1.59.0 — a test auditions the rung a real alarm of that condition would use.
      const testRung: AlarmRung = level === 'red' ? 'critical' : level === 'yellow' ? 'medium' : 'clear';
      // v1.186.0 — kind 'test': it plays through every gate and arms none of them, takes no
      // retry slot, and is never the restart baseline (see BroadcastKind).
      const r = await runBroadcast(level, testRung, message, true, messageEs, false, 'test');
      lastBroadcastAt = Date.now();
      lastLevel = level; lastBroadcastKind = 'test';
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
    // v1.186.4 — takes a RUNG: `clear` auditions the all-clear tone with the
    // recovery broadcast's words marked as a preview (ALL_CLEAR_PREVIEW_MESSAGE),
    // at green as conditionFromAlerts plays it.
    preview: async (rung: AlarmRung, target: 'browser' | 'speakers') => {
      cfg = loadBroadcastConfig();
      const spokenText = rung === 'clear' ? ALL_CLEAR_PREVIEW_MESSAGE : previewMessageFor(rung);
      const level = rung === 'clear' ? 'green' : klaxonLevelForPriority(rung);
      // v1.59.0 — preview auditions the rung the real alarm will use. `level` is
      // still computed because the surrounding cooldown/policy code speaks it.
      const previewRung: AlarmRung = rung;

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
      const previewChime = resolveChime(previewRung, opts.klaxonDir);
      const r = await renderAnnouncement({
        level: previewRung,
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
        renderTts: opts.renderTts, // v1.186.4 — the same test seam as runBroadcast; undefined in production
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

      // 3. Speakers target → play to EVERY configured speaker, the MA targets
      //    AND the SIP cordless: the set a real alarm reaches. v1.186.4 — the
      //    preview used to call playAnnounce alone, so the cordless never heard it.
      if (!supervised) {
        return { ok: false, spokenText, audioPath, played: 'speakers', error: 'not supervised' };
      }
      // Refused exactly where a real alarm is (runBroadcastAttempt): with no Music
      // Assistant target nothing plays, the cordless included, so a preview that
      // rang the cordless alone would pass a configuration every real alarm fails.
      if (cfg.targets.length === 0) {
        return { ok: false, spokenText, audioPath, played: 'speakers', error: 'no targets configured' };
      }
      const url = `${cfg.audioBase}${opts.cacheUrlPath}/${r.filename}`;
      // Both channels run together and the preview waits for both, so the result
      // reports each rather than the Music Assistant half alone. playSipAnnounce
      // never throws and returns zero tallies when no SIP target is configured.
      const [call, sip] = await Promise.all([
        detectMusicAssistant().then(() => playAnnounce(url, r.sizeBytes)),
        playSipAnnounce(url),
      ]);
      lastBroadcastAt = Date.now();
      lastLevel = level; lastBroadcastKind = 'preview';
      const out = previewSpeakerOutcome({ targets: cfg.targets.length, call }, sip);
      if (!out.ok) {
        lastOutcome = 'partial';
        lastErrors = [out.error ?? 'preview failed'];
        return { ok: false, spokenText, audioPath, played: 'speakers', error: out.error, delivered: out.delivered, note: out.note };
      }
      lastOutcome = 'success';
      lastErrors = [];
      log(`broadcast: preview ${rung} (${level}) → played to ${out.delivered} target(s)`);
      return { ok: true, spokenText, audioPath, played: 'speakers', delivered: out.delivered, note: out.note };
    },
    // v0.12.0 — dedicated audible for one backup-SoC threshold crossing. Maps
    // priority → klaxon level, then reuses runBroadcast() so the render (chime
    // + TTS) and the Music-Assistant play path are IDENTICAL
    // to a real condition-transition broadcast. The SoC monitor edge-limits
    // crossings, so we deliberately apply NO cooldown here. Never throws.
    /**
     * @param opts.consentNotice v1.122.0 — this announcement is a CONSENT
     * CHECKPOINT (the supervised night-charge arm/cancel), not a repeat of a
     * standing condition, so it bypasses the same-level storm gate.
     *
     * THE DEFECT: the evening arm job is pinned at 21:30 and the SoC ladder
     * routinely chimes in the same minute band (09-01 21:28:29, 09-02 20:09:23).
     * SAME_LEVEL_GAP_MS is 2 min and a 'medium' arm notice after a 'medium' SoC
     * chime is not an escalation, so on 2026-09-01 the arm was dropped 107 s
     * after the ladder — "supervised announce suppressed (suppressed:
     * same-or-lower level within gap) — arm delivered via HA notify". The whole
     * safety story of the supervised posture is that the owner is TOLD before a
     * device write and can cancel until the write moment; that checkpoint
     * silently degraded to a phone-only channel. It fires at most twice a night
     * (arm, cancel), so it cannot storm.
     */
    announce: async (
      priority: AlarmPriority,
      message: string,
      messageEs: string | null,
      opts?: { consentNotice?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
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
        const r = await runBroadcast(level, priority, message, opts?.consentNotice === true, messageEs);
        // v1.187.0 — a storm-gated announcement is recorded apart (noteSuppression, in the gate):
        // nothing was rendered or played, so it is not the last broadcast.
        if (!isStormSuppression(r)) {
          lastBroadcastAt = Date.now();
          lastLevel = level; lastBroadcastKind = 'dedicated';
          lastOutcome = r.ok ? 'success' : 'partial';
          lastErrors = r.errors;
        }
        // v1.48.0 — dedicated-path alarms (SoC ladder / runway) earn the same
        // one-shot spoken retry as condition broadcasts, replaying THIS message.
        noteSpokenRenderFailure(level, priority, r, message, messageEs);
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
      // v1.131.0 — report the SIP cordless too. cfg.sipTargets was added in
      // v1.25.0 and threaded through dispatch and the log lines ("2 MA + 1 SIP")
      // but status() kept the pre-v1.25.0 single-list shape, so /api/broadcast
      // named two of three speakers — and the one it omitted is specifically the
      // redundant channel designed to work when Music Assistant is down. An
      // operator reading targetCount:2 during an MA outage would conclude the
      // audible channel was fully dead.
      targetCount: cfg.targets.length + cfg.sipTargets.length,
      targets: cfg.targets,
      maTargets: cfg.targets,
      sipTargets: cfg.sipTargets,
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
      // v1.187.0 — the last storm-gate suppression, apart from the last broadcast.
      lastSuppressedAt,
      lastSuppressedLevel,
      lastSuppressedKind,
      lastSuppressedReason,
      // v0.84.0 — audible-delivery health (feeds the operator self-alert + sensor).
      audibleReachable,
      audibleUsableTargets,
      audibleReason,
      // v1.186.0 — additive: the MA denominator, the degraded channel, the broadcast kind and
      // the condition record the next boot's baseline comes from.
      audibleConfiguredTargets: cfg.targets.length,
      audibleDegraded,
      audibleUnusableTargets: [...audibleUnusable],
      lastBroadcastKind,
      conditionLevel,
      conditionSpoken,
      conditionAt,
      bootBaselineLevel,
      lastRender: { ...lastRender },
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
      clearInterval(pruneInterval);
      clearInterval(audibleHealthInterval);
      clearTimeout(audibleHealthKick);
      clearTimeout(prewarmTimer);
      offRuntimeConfig();
    },
  };
}
