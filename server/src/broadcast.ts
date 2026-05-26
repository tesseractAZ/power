/**
 * v0.9.18 — Ship-wide audible broadcast to HomePod + Sonos.
 *
 * Listens to alert-condition transitions (any → red, green → yellow,
 * red/yellow → green) and pushes the appropriate Starfleet alert sound
 * to every configured speaker via Home Assistant's `media_player`
 * service. Optionally appends a TTS-generated situational announcement.
 *
 * Configuration is env-driven (set from the HA add-on Configuration tab):
 *
 *   BROADCAST_ENABLED       true / false (default false — opt-in)
 *   BROADCAST_TARGETS       comma-separated media_player entity IDs
 *                           e.g. "media_player.living_room, media_player.kitchen"
 *   BROADCAST_AUDIO_BASE    URL prefix for the WAV files; defaults to
 *                           "http://homeassistant.local:8787" — the
 *                           speaker must be able to reach this URL on
 *                           the LAN. Set to your HA Pi's IP if mDNS
 *                           resolution is flaky.
 *   BROADCAST_VOLUME        0..1 (default 0.5). Applied via
 *                           media_player.volume_set before play_media.
 *   BROADCAST_MIN_SEVERITY  "critical" | "warning" — alarm level below
 *                           this never broadcasts. Default "critical".
 *   BROADCAST_QUIET_HOURS   "22-06" (or empty). Non-critical alarms
 *                           are suppressed during this window. Critical
 *                           always fires.
 *   BROADCAST_TTS_SERVICE   e.g. "tts.google_translate_say" or
 *                           "tts.cloud_say" or "tts.piper". Empty
 *                           disables verbal announcements (klaxon only).
 *   BROADCAST_TTS_LANGUAGE  e.g. "en-US" for Google. Engine-specific.
 *   BROADCAST_SONOS_RESTORE true / false — wrap each Sonos broadcast in
 *                           sonos.snapshot + sonos.restore so we don't
 *                           leave music paused. Default true.
 *
 * Broadcast policy (deliberate — see the "every detail matters" note
 * from the user):
 *
 *   - Fires on CONDITION TRANSITIONS, not per-tick. Going 3 crit → 2
 *     crit (one cleared, still RED) is silent. A NEW critical alert
 *     while already RED re-fires the klaxon (shorter form).
 *   - First-render is silent. Joining an already-RED state at boot
 *     doesn't klaxon the house.
 *   - Min severity gates the broadcast. With default "critical", only
 *     red alerts fire. Set to "warning" to also broadcast yellow.
 *   - Quiet hours only affect warning / info broadcasts. Critical
 *     always fires regardless of time of day (the whole point of
 *     critical: someone needs to know).
 *   - Test broadcast (`POST /api/broadcast/test`) bypasses all gates.
 */

import type { SnapshotStore } from './snapshot.js';
import type { Alert } from './alerts.js';
import { callHaService, isSupervised, hasService } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';
// v0.9.29 — protocol-aware grouping + TTS auto-detection
import {
  profileTargets,
  groupByProtocol,
  scheduleStagger,
  type SpeakerProfile,
  type SpeakerGroup,
} from './speakerProfiles.js';
import {
  detectTtsEngines,
  pickBestEngine,
  buildAlertMessage,
  speakWithFallback,
  speakViaMusicAssistant,
  type TtsEngine,
} from './ttsService.js';

export type BroadcastBackend = 'auto' | 'music_assistant' | 'media_player';

export interface BroadcastConfig {
  enabled: boolean;
  targets: string[];
  audioBase: string;
  volume: number;
  minSeverity: 'critical' | 'warning';
  quietHours: [number, number] | null;
  ttsService: string | null;        // e.g. "tts.google_translate_say"
  ttsLanguage: string | null;
  sonosRestore: boolean;
  /** v0.9.23 — which HA service path to use. 'auto' picks MA if installed. */
  backend: BroadcastBackend;
  /** v0.9.40 — Base URL of HA Core (for TTS proxy URLs sent to speakers).
   *  Defaults to http://homeassistant.local:8123 when unset. */
  haExternalUrl: string | null;
}

export function loadBroadcastConfig(): BroadcastConfig {
  const targetsRaw = process.env.BROADCAST_TARGETS ?? '';
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('media_player.'));
  const backendRaw = (process.env.BROADCAST_USE_MUSIC_ASSISTANT ?? 'auto').toLowerCase();
  const backend: BroadcastBackend =
    backendRaw === 'true' || backendRaw === 'music_assistant' ? 'music_assistant' :
    backendRaw === 'false' || backendRaw === 'media_player' ? 'media_player' :
    'auto';
  return {
    enabled: process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1',
    targets,
    audioBase: (process.env.BROADCAST_AUDIO_BASE || 'http://homeassistant.local:8787').replace(/\/$/, ''),
    volume: clamp01(Number(process.env.BROADCAST_VOLUME ?? 0.5)),
    minSeverity: (process.env.BROADCAST_MIN_SEVERITY ?? 'critical') === 'warning' ? 'warning' : 'critical',
    quietHours: parseQuietHours(process.env.BROADCAST_QUIET_HOURS ?? ''),
    ttsService: emptyToNull(process.env.BROADCAST_TTS_SERVICE),
    ttsLanguage: emptyToNull(process.env.BROADCAST_TTS_LANGUAGE),
    sonosRestore: process.env.BROADCAST_SONOS_RESTORE !== 'false',
    backend,
    haExternalUrl: emptyToNull(process.env.BROADCAST_HA_EXTERNAL_URL),
  };
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
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const level: ConditionLevel = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green';
  return { level, crit, warn };
}

/* ─── monitor ─────────────────────────────────────────────────────── */

export interface BroadcastMonitor {
  /** Force a test broadcast (bypasses every gate except the cooldown). */
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[]; cooldownRemainingMs?: number }>;
  /** Current config snapshot. */
  config: () => BroadcastConfig;
  /** Last-broadcast status for the diagnostic endpoint. */
  status: () => BroadcastStatus;
  /** Stop polling on shutdown. */
  stop: () => void;
}

export interface BroadcastStatus {
  supervised: boolean;
  enabled: boolean;
  targetCount: number;
  lastBroadcastAt: number | null;
  lastLevel: ConditionLevel | null;
  lastOutcome: 'success' | 'partial' | 'failure' | null;
  lastErrors: string[];
  /** v0.9.23 — which backend was used on the last broadcast. */
  lastBackend: 'music_assistant' | 'media_player' | null;
  /** v0.9.23 — does HA expose Music Assistant's announce service? */
  musicAssistantAvailable: boolean;
  /** v0.9.23 — ms until the test endpoint will accept another call. 0 = ready. */
  testCooldownRemainingMs: number;
  /** v0.9.29 — protocol-grouped target view, used by the discover UI + diagnostics. */
  speakerGroups: Array<{ protocol: string; bufferMs: number; targets: string[]; fireAtMs: number }>;
  /** v0.9.29 — TTS engine currently in use (auto-picked or user-configured). */
  ttsEngine: { service: string; label: string; local: boolean } | null;
  /** v0.9.29 — every TTS engine detected in HA (for the picker UI). */
  ttsAvailable: Array<{ service: string; label: string; local: boolean }>;
  /** v0.9.29 — last broadcast's spoken message (debug surface). */
  lastSpokenMessage: string | null;
}

/** v0.9.23 — cooldown on the test endpoint. Rapid retests during
 *  v0.9.18-19 debugging cascaded into 502s because each fresh test
 *  collided with the in-flight Music Assistant stream. 10 s is plenty
 *  for any single broadcast (klaxon + transition) to settle. */
const TEST_COOLDOWN_MS = 10_000;

export function startBroadcastMonitor(
  store: SnapshotStore,
  log: (m: string) => void,
): BroadcastMonitor {
  let cfg = loadBroadcastConfig();
  let prevLevel: ConditionLevel | null = null;
  let prevCrit = 0;
  let firstTick = true;
  let stopped = false;
  let lastBroadcastAt: number | null = null;
  let lastLevel: ConditionLevel | null = null;
  let lastOutcome: BroadcastStatus['lastOutcome'] = null;
  let lastErrors: string[] = [];
  let lastBackend: BroadcastStatus['lastBackend'] = null;
  let lastTestAt = 0;
  let musicAssistantAvailable = false;
  // v0.9.29 — speaker grouping + TTS state
  let speakerGroups: SpeakerGroup[] = [];
  let cachedProfiles: SpeakerProfile[] = [];
  let cachedProfilesAt = 0;
  let ttsEngine: TtsEngine | null = null;
  let ttsAvailable: TtsEngine[] = [];
  let lastSpokenMessage: string | null = null;
  const PROFILE_CACHE_MS = 5 * 60 * 1000; // refresh profiles every 5 min

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

  /** v0.9.23 — Music Assistant detection. We check the service catalog
   *  on startup (and again after each config-reload tick that flips backend
   *  to auto). MA's purpose-built announce service is a much better fit
   *  than media_player.play_media for our broadcast use case:
   *
   *    - plays simultaneously across all targets (not serial per speaker)
   *    - returns immediately (doesn't block on per-speaker acks)
   *    - handles volume override + restore atomically
   *    - bypasses the MA play queue (won't interrupt music sessions)
   *
   *  If the user explicitly sets BROADCAST_USE_MUSIC_ASSISTANT=false we
   *  skip detection. If they force =true and MA isn't installed, we still
   *  fall back at runBroadcast() time with a clear error message. */
  const detectMusicAssistant = async () => {
    if (!supervised || cfg.backend === 'media_player') {
      musicAssistantAvailable = false;
      return;
    }
    musicAssistantAvailable = await hasService('music_assistant', 'play_announcement');
    if (musicAssistantAvailable) {
      log('broadcast: music_assistant.play_announcement detected — preferring it over media_player.play_media');
    } else if (cfg.backend === 'music_assistant') {
      log('broadcast: BROADCAST_USE_MUSIC_ASSISTANT=true but music_assistant.play_announcement not available; calls will fail');
    } else {
      log('broadcast: music_assistant not detected, using media_player.play_media');
    }
  };

  /** v0.9.29 — Auto-detect TTS engines available in HA. Preference order
   *  is encoded in ttsService.ts (Piper > Cloud > Google > ElevenLabs).
   *  If the user set BROADCAST_TTS_SERVICE explicitly we honor it; else
   *  we auto-pick the highest-quality available engine, defaulting to
   *  Piper which is local (off-grid safe) and free. */
  const detectTts = async () => {
    if (!supervised) {
      ttsEngine = null;
      ttsAvailable = [];
      return;
    }
    ttsAvailable = await detectTtsEngines();
    ttsEngine = await pickBestEngine(cfg.ttsService);
    if (ttsEngine) {
      const src = cfg.ttsService === ttsEngine.service ? 'configured' : 'auto-picked';
      log(`broadcast: TTS engine ${src}: ${ttsEngine.label} (${ttsEngine.service})${ttsEngine.local ? ' [local/off-grid OK]' : ''}`);
    } else if (cfg.ttsService) {
      log(`broadcast: BROADCAST_TTS_SERVICE=${cfg.ttsService} not available; spoken alerts disabled`);
    } else if (ttsAvailable.length === 0) {
      log('broadcast: no TTS engines detected (install Piper add-on for local TTS — strongly recommended for off-grid)');
    }
  };

  /** v0.9.29 — Refresh speaker protocol profiles. Cached to avoid
   *  hammering HA's /states on every broadcast — speakers don't change
   *  protocol mid-day. Forced refresh after config changes or every 5 min. */
  const refreshSpeakerGroups = async (force = false) => {
    if (!supervised) {
      speakerGroups = [];
      cachedProfiles = [];
      return;
    }
    const stale = Date.now() - cachedProfilesAt > PROFILE_CACHE_MS;
    if (!force && !stale && cachedProfiles.length === cfg.targets.length) return;
    cachedProfiles = await profileTargets(cfg.targets);
    cachedProfilesAt = Date.now();
    speakerGroups = groupByProtocol(cachedProfiles);
    if (speakerGroups.length > 0) {
      const groupSummary = speakerGroups
        .map((g) => `${g.protocol}×${g.targets.length} (${g.bufferMs}ms)`)
        .join(', ');
      log(`broadcast: speaker groups (fire-first → last): ${groupSummary}`);
    }
  };

  void (async () => {
    await detectMusicAssistant();
    await detectTts();
    await refreshSpeakerGroups(true);
  })();

  const inQuiet = (): boolean => {
    if (!cfg.quietHours) return false;
    return inQuietWindow(new Date(), cfg.quietHours);
  };

  /**
   * Decide which HA backend to use for this broadcast.
   *
   *   - explicit 'music_assistant' → use MA even if detection failed
   *     (user will see the failure if it really isn't installed)
   *   - explicit 'media_player' → never use MA
   *   - 'auto' → use MA if detected, else media_player
   */
  const pickBackend = (): 'music_assistant' | 'media_player' => {
    if (cfg.backend === 'music_assistant') return 'music_assistant';
    if (cfg.backend === 'media_player') return 'media_player';
    return musicAssistantAvailable ? 'music_assistant' : 'media_player';
  };

  /**
   * Run one broadcast via Music Assistant's purpose-built announce service.
   * This is the preferred path: simultaneous across all targets, returns
   * immediately, handles volume override + restore atomically.
   *
   * MA expects announce_volume as 0-100 percent integer, not 0-1 float —
   * convert before sending. The TTS is appended as a SECOND announcement
   * because play_announcement plays one URL per call.
   */
  const runBroadcastMA = async (
    level: ConditionLevel,
    targets: string[],
  ): Promise<{ ok: boolean; errors: string[] }> => {
    const errors: string[] = [];
    const wav = `${cfg.audioBase}/audio/${level === 'red' ? 'red-alert' : level === 'yellow' ? 'yellow-alert' : 'all-clear'}.wav`;
    const announceVolume = Math.round(cfg.volume * 100);

    // Main klaxon. use_pre_announce=false because the WAV itself is the alert tone.
    const r = await callHaService('music_assistant', 'play_announcement', {
      entity_id: targets,
      url: wav,
      use_pre_announce: false,
      announce_volume: announceVolume,
    });
    if (!r.ok) errors.push(`music_assistant.play_announcement (${targets.length}): ${r.error ?? r.status}`);

    return { ok: errors.length === 0, errors };
  };

  /**
   * Run one broadcast via the original media_player.play_media path.
   * Used when Music Assistant isn't available or the user has forced
   * BROADCAST_USE_MUSIC_ASSISTANT=false. Same behavior as v0.9.18-22.
   */
  const runBroadcastMP = async (
    level: ConditionLevel,
    targets: string[],
  ): Promise<{ ok: boolean; errors: string[] }> => {
    const errors: string[] = [];
    const wav = `${cfg.audioBase}/audio/${level === 'red' ? 'red-alert' : level === 'yellow' ? 'yellow-alert' : 'all-clear'}.wav`;

    const sonosTargets = targets.filter((t) => t.includes('sonos') || /\bsonos\b/i.test(t));
    if (cfg.sonosRestore && sonosTargets.length > 0) {
      const r = await callHaService('sonos', 'snapshot', { entity_id: sonosTargets, with_group: true });
      if (!r.ok) errors.push(`sonos.snapshot: ${r.error ?? r.status}`);
    }

    const volRes = await callHaService('media_player', 'volume_set', {
      entity_id: targets,
      volume_level: cfg.volume,
    });
    if (!volRes.ok) errors.push(`volume_set (${targets.length}): ${volRes.error ?? volRes.status}`);

    const kRes = await callHaService('media_player', 'play_media', {
      entity_id: targets,
      media_content_id: wav,
      media_content_type: 'music',
      announce: true,
    });
    if (!kRes.ok) errors.push(`play_media (${targets.length}): ${kRes.error ?? kRes.status}`);

    // Sonos restore is scheduled by the orchestrator after the spoken
    // announcement (if any) finishes — see runBroadcast() below.

    return { ok: errors.length === 0, errors };
  };

  /** Schedule a Sonos snapshot-restore pair around the broadcast window. */
  const scheduleSonosRestore = async (targets: string[], settleMs: number): Promise<string[]> => {
    const errors: string[] = [];
    const sonosTargets = targets.filter((t) => t.includes('sonos') || /\bsonos\b/i.test(t));
    if (!cfg.sonosRestore || sonosTargets.length === 0) return errors;
    await sleep(settleMs);
    const r = await callHaService('sonos', 'restore', { entity_id: sonosTargets, with_group: true });
    if (!r.ok) errors.push(`sonos.restore: ${r.error ?? r.status}`);
    return errors;
  };

  /**
   * v0.9.29 — Staggered orchestrator. Walks the protocol-grouped speaker list
   * in fire-first order (longest buffer first) and dispatches one group
   * per scheduled fireAtMs offset. Net effect: all speakers BEGIN PLAYING
   * within ~300 ms of each other in wall-clock time, even though the API
   * calls happen over a 1-2 second window.
   *
   * Then, after the klaxon settles (~3 sec), fires a TTS announcement of
   * the spoken `message` if one was provided and a TTS engine is available.
   *
   * Falls back to a single all-targets call when grouping is unavailable
   * (no HA, no profile cache yet, etc.).
   */
  const runBroadcast = async (
    level: ConditionLevel,
    message: string | null,
  ): Promise<{ ok: boolean; errors: string[]; backend: 'music_assistant' | 'media_player' }> => {
    if (!supervised) {
      return { ok: false, errors: ['not supervised'], backend: 'media_player' };
    }
    if (cfg.targets.length === 0) {
      return { ok: false, errors: ['no targets configured'], backend: 'media_player' };
    }
    await refreshSpeakerGroups();
    const backend = pickBackend();
    const t0 = Date.now();
    const errors: string[] = [];

    // Decide grouping. When we have valid groups (>1), stagger them.
    // When we only have one group (or no groups), fire all at once.
    const groups = speakerGroups.length > 0 ? speakerGroups : [{
      protocol: 'unknown' as const,
      bufferMs: 1000,
      targets: cfg.targets,
    }];
    const schedule = scheduleStagger(groups);

    // Fire each group at its scheduled offset. Promise.all coordinates
    // the per-group setTimeout fires; individual group results land
    // independently. We await all so error reporting is complete.
    await Promise.all(schedule.map(async ({ group, fireAtMs }) => {
      if (fireAtMs > 0) await sleep(fireAtMs);
      const r = backend === 'music_assistant'
        ? await runBroadcastMA(level, group.targets)
        : await runBroadcastMP(level, group.targets);
      if (!r.ok) errors.push(...r.errors.map((e) => `[${group.protocol}] ${e}`));
    }));

    // After the klaxon: fire TTS announcement if available + requested.
    //
    // v0.9.43 — wait long enough for MA's klaxon announce to fully
    // complete its queue before firing a second play_announcement for
    // TTS. v0.9.41 testing (RED broadcast) showed:
    //   - tts-via-MA(tts.speak:tts.home_assistant_cloud): 500
    // even though standalone Cloud TTS worked. MA was rejecting the
    // SECOND play_announcement because its first one (klaxon) hadn't
    // fully completed its queue/restore cycle yet. The 3.5s wait from
    // v0.9.39-41 wasn't enough.
    //
    // Empirical: MA's announce service holds the queue for ~5-7 sec
    // after the audio finishes (volume restore + speaker re-acquire).
    // For a 3-sec red klaxon, we need ~8 sec total wait so MA has
    // released the queue before our second announce hits. For the 1.5-sec
    // yellow/green klaxons, 5 sec is sufficient.
    const klaxonSettleMs = level === 'red' ? 8000 : 5000;
    // v0.9.43 — track the engine actually used (vs configured preferred)
    // so the success log message reports truth instead of the preferred
    // engine when fallback kicked in.
    let actualEngineUsed: TtsEngine | null = null;

    if (message && ttsEngine) {
      await sleep(klaxonSettleMs);

      // v0.9.40 — MA-routed TTS path. The previous v0.9.39 fix
      // (`media_stop` before `tts.speak`) didn't work because
      // MA-managed speakers stay bound to MA's session even after a
      // media_stop — MA immediately re-acquires them. The fix is to
      // route the TTS THROUGH MA: render the message to an MP3 URL
      // via HA's `tts_get_url`, then play that URL via the same
      // `music_assistant.play_announcement` service we used for the
      // klaxon. MA owns all audio output, no contention.
      //
      // Only the modern `tts.speak:<entity>` engines support URL
      // rendering. Legacy engines (e.g., `tts.cloud_say`) fall back
      // to the direct `tts.speak`/legacy path via `speakWithFallback`.
      const engineChain: TtsEngine[] = [ttsEngine];
      for (const e of ttsAvailable) {
        if (!engineChain.find((x) => x.service === e.service)) engineChain.push(e);
      }
      const announceVolumePct = Math.round(cfg.volume * 100);

      let spoken = false;
      let usedEngine: TtsEngine | null = null;
      const attemptErrors: string[] = [];

      if (backend === 'music_assistant') {
        // Try each engine via MA-routed path first.
        // v0.9.43 — retry each engine once on 500 with a 2-sec wait, in
        // case MA's klaxon-announce queue still hadn't released. Same
        // pattern as speakWithFallback's per-engine retry but tuned for
        // MA's slower settle window.
        for (const eng of engineChain) {
          if (!eng.service.startsWith('tts.speak:')) continue;
          let r = await speakViaMusicAssistant(message, {
            engine: eng,
            targets: cfg.targets,
            language: cfg.ttsLanguage,
            externalBaseUrl: cfg.haExternalUrl,
            announceVolume: announceVolumePct,
          });
          if (!r.ok && r.status === 500) {
            await sleep(2000);
            r = await speakViaMusicAssistant(message, {
              engine: eng,
              targets: cfg.targets,
              language: cfg.ttsLanguage,
              externalBaseUrl: cfg.haExternalUrl,
              announceVolume: announceVolumePct,
            });
          }
          if (r.ok) {
            spoken = true;
            usedEngine = eng;
            if (r.ttsUrl) log(`broadcast: TTS via MA ok (engine=${eng.service}, url=${r.ttsUrl})`);
            break;
          }
          attemptErrors.push(`tts-via-MA(${eng.service}): ${r.error ?? r.status}`);
        }
      }

      if (!spoken) {
        // Fallback: direct tts.speak / legacy service path with retry.
        // Still useful for legacy engines or when render-to-URL failed.
        const tRes = await speakWithFallback(message, engineChain, {
          targets: cfg.targets,
          language: cfg.ttsLanguage,
          viaMusicAssistant: backend === 'music_assistant',
        });
        if (tRes.result.ok) {
          spoken = true;
          usedEngine = tRes.engineUsed;
        } else {
          for (const a of tRes.attempts) {
            attemptErrors.push(`tts(${a.engine.service}): ${a.error}`);
          }
        }
      }

      if (spoken) {
        lastSpokenMessage = message;
        actualEngineUsed = usedEngine;
        if (usedEngine && usedEngine.service !== ttsEngine.service) {
          log(`broadcast: TTS fell back from ${ttsEngine.service} to ${usedEngine.service}`);
        }
      } else {
        errors.push(...attemptErrors);
      }
    }

    // Sonos snapshot-restore wraps the whole window for the MP path.
    if (backend === 'media_player') {
      const settleMs = (message && ttsEngine ? 8000 : klaxonSettleMs);
      const sErrors = await scheduleSonosRestore(cfg.targets, settleMs);
      errors.push(...sErrors);
    }

    const dt = Date.now() - t0;
    const groupSummary = groups.map((g) => `${g.protocol}×${g.targets.length}`).join('+');
    if (errors.length === 0) {
      // v0.9.43 — report the engine that ACTUALLY spoke, not just the
      // configured preferred engine (which may have failed and fallen back).
      const ttsLabel = actualEngineUsed ? actualEngineUsed.service : ttsEngine?.service ?? null;
      log(`broadcast: ${level} via ${backend} → ok in ${dt}ms (${groupSummary}${ttsLabel && message ? `, +tts ${ttsLabel}` : ''})`);
    } else {
      log(`broadcast: ${level} via ${backend} → ${errors.length} error(s) in ${dt}ms: ${errors.join('; ')}`);
    }
    return { ok: errors.length === 0, errors, backend };
  };

  /**
   * v0.9.29 — Build a clear, hearable TTS announcement from the current
   * alert set. Returns null when no TTS engine is available. Critical
   * alerts get an "Acknowledge at console" tag + a brief repeat — the
   * pre-v0.9.29 version was a single short sentence that was easy to miss.
   */
  const messageFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    if (!ttsEngine) return null;
    return buildAlertMessage(level, alerts);
  };

  /* ── tick ─── periodic check for condition transitions */
  const tick = async () => {
    if (stopped) return;
    cfg = loadBroadcastConfig(); // re-read each tick so config changes apply without restart
    const alerts = (store.get().alerts ?? []) as Alert[];
    const { level, crit } = conditionFromAlerts(alerts);
    if (firstTick) {
      firstTick = false;
      prevLevel = level;
      prevCrit = crit;
      return;
    }
    const transitioned = level !== prevLevel;
    const newCrit = level === 'red' && crit > prevCrit;
    if (!transitioned && !newCrit) {
      return;
    }
    // Severity gate.
    if (!cfg.enabled) { prevLevel = level; prevCrit = crit; return; }
    if (level === 'yellow' && cfg.minSeverity === 'critical') { prevLevel = level; prevCrit = crit; return; }
    // Quiet-hours gate — critical always fires.
    if (level !== 'red' && inQuiet()) {
      log(`broadcast: ${level} suppressed by quiet hours`);
      prevLevel = level; prevCrit = crit; return;
    }
    log(`broadcast: condition ${prevLevel} → ${level}${newCrit ? ' (new crit)' : ''}, ${cfg.targets.length} target(s)`);
    const message = messageFor(level, alerts);
    const result = await runBroadcast(level, message);
    lastBroadcastAt = Date.now();
    lastLevel = level;
    lastOutcome = result.ok ? 'success' : 'partial';
    lastErrors = result.errors;
    lastBackend = result.backend;
    prevLevel = level;
    prevCrit = crit;
  };

  const tickInterval = setInterval(() => { tick().catch((e) => log(`broadcast: tick failed: ${e?.message ?? e}`)); }, 10_000);
  tickInterval.unref();

  return {
    test: async (level: ConditionLevel = 'red') => {
      cfg = loadBroadcastConfig();
      // v0.9.23 — cooldown gate. Prevents the "rapid clicks → cascading 502s"
      // pattern observed in the v0.9.22 log (4 broadcasts in 30s overwhelmed
      // Music Assistant's queue).
      const remaining = Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now());
      if (remaining > 0) {
        return {
          ok: false,
          messages: [`cooldown: wait ${Math.ceil(remaining / 1000)}s before testing again`],
          cooldownRemainingMs: remaining,
        };
      }
      lastTestAt = Date.now();
      // Re-detect MA + TTS + refresh groups on every test — cheap, and the
      // user may have installed Piper or rearranged speakers since startup.
      await detectMusicAssistant();
      await detectTts();
      await refreshSpeakerGroups(true);
      const message =
        level === 'red' ? 'Test broadcast. Red alert klaxon. This is only a test. Repeat. Red alert. This is only a test.' :
        level === 'yellow' ? 'Test broadcast. Yellow alert chime. This is only a test.' :
        'Test broadcast. All clear chime. This is only a test.';
      const r = await runBroadcast(level, ttsEngine ? message : null);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = r.ok ? 'success' : 'partial';
      lastErrors = r.errors;
      lastBackend = r.backend;
      return {
        ok: r.ok,
        messages: r.errors,
        cooldownRemainingMs: TEST_COOLDOWN_MS,
      };
    },
    config: () => cfg,
    status: () => {
      const schedule = scheduleStagger(speakerGroups);
      return {
        supervised,
        enabled: cfg.enabled,
        targetCount: cfg.targets.length,
        lastBroadcastAt,
        lastLevel,
        lastOutcome,
        lastErrors,
        lastBackend,
        musicAssistantAvailable,
        testCooldownRemainingMs: Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now()),
        // v0.9.29
        speakerGroups: schedule.map(({ group, fireAtMs }) => ({
          protocol: group.protocol,
          bufferMs: group.bufferMs,
          targets: group.targets,
          fireAtMs,
        })),
        ttsEngine: ttsEngine ? { service: ttsEngine.service, label: ttsEngine.label, local: ttsEngine.local } : null,
        ttsAvailable: ttsAvailable.map((e) => ({ service: e.service, label: e.label, local: e.local })),
        lastSpokenMessage,
      };
    },
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
