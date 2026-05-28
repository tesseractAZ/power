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

import type { SnapshotStore } from './snapshot.js';
import type { Alert } from './alerts.js';
import { callHaService, isSupervised, hasService } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';
import { renderAnnouncement, pruneRenderCache } from './audioRenderer.js';
import { buildAlertMessage } from './ttsService.js';

/* ─── config ──────────────────────────────────────────────────────── */

export interface BroadcastConfig {
  enabled: boolean;
  targets: string[];
  audioBase: string;
  volume: number;
  minSeverity: 'critical' | 'warning';
  quietHours: [number, number] | null;
  /** v0.9.70 — Wyoming server location for TTS rendering. */
  wyomingHost: string;
  wyomingPort: number;
  /** v0.9.70 — optional Piper voice override (e.g. "en_US-amy-medium").
   *  Empty → use Piper add-on's configured default voice. */
  wyomingVoice: string | null;
}

export function loadBroadcastConfig(): BroadcastConfig {
  const targetsRaw = process.env.BROADCAST_TARGETS ?? '';
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('media_player.'));
  return {
    enabled: process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1',
    targets,
    audioBase: (process.env.BROADCAST_AUDIO_BASE || 'http://homeassistant.local:8787').replace(/\/$/, ''),
    volume: clamp01(Number(process.env.BROADCAST_VOLUME ?? 0.5)),
    minSeverity: (process.env.BROADCAST_MIN_SEVERITY ?? 'critical') === 'warning' ? 'warning' : 'critical',
    quietHours: parseQuietHours(process.env.BROADCAST_QUIET_HOURS ?? ''),
    wyomingHost: process.env.BROADCAST_WYOMING_HOST || 'core-piper',
    wyomingPort: Number(process.env.BROADCAST_WYOMING_PORT) || 10200,
    wyomingVoice: emptyToNull(process.env.BROADCAST_WYOMING_VOICE),
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
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[]; cooldownRemainingMs?: number }>;
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
  let prevLevel: ConditionLevel | null = null;
  let prevCrit = 0;
  let firstTick = true;
  let stopped = false;
  let lastBroadcastAt: number | null = null;
  let lastLevel: ConditionLevel | null = null;
  let lastOutcome: BroadcastStatus['lastOutcome'] = null;
  let lastErrors: string[] = [];
  let lastTestAt = 0;
  let musicAssistantAvailable = false;
  let wyomingReachable: boolean | null = null;
  let lastSpokenMessage: string | null = null;
  let lastRender: BroadcastStatus['lastRender'] = {
    filename: null, sizeBytes: null, ttsRenderMs: null, fromCache: null, error: null,
  };

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

  const detectMusicAssistant = async () => {
    if (!supervised) {
      musicAssistantAvailable = false;
      return;
    }
    musicAssistantAvailable = await hasService('music_assistant', 'play_announcement');
    if (musicAssistantAvailable) {
      log('broadcast: music_assistant.play_announcement detected');
    } else {
      log('broadcast: music_assistant.play_announcement NOT detected — broadcasts will fail until MA is installed');
    }
  };

  void detectMusicAssistant();

  const inQuiet = (): boolean => {
    if (!cfg.quietHours) return false;
    return inQuietWindow(new Date(), cfg.quietHours);
  };

  /**
   * Single broadcast: render → one MA call. No staggering, no settles.
   */
  const runBroadcast = async (
    level: ConditionLevel,
    message: string | null,
  ): Promise<{ ok: boolean; errors: string[] }> => {
    if (!supervised) return { ok: false, errors: ['not supervised'] };
    if (cfg.targets.length === 0) return { ok: false, errors: ['no targets configured'] };

    const errors: string[] = [];
    const t0 = Date.now();

    // 1. Render combined announcement WAV (cache-aware).
    const r = await renderAnnouncement({
      level,
      message,
      klaxonDir: opts.klaxonDir,
      cacheDir: opts.cacheDir,
      wyomingHost: cfg.wyomingHost,
      wyomingPort: cfg.wyomingPort,
      wyomingVoice: cfg.wyomingVoice ?? undefined,
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

    // 2. Single MA play_announcement to every target.
    const url = `${cfg.audioBase}${opts.cacheUrlPath}/${r.filename}`;
    const announceVolume = Math.round(cfg.volume * 100);
    const call = await callHaService('music_assistant', 'play_announcement', {
      entity_id: cfg.targets,
      url,
      use_pre_announce: false,
      announce_volume: announceVolume,
    });
    if (!call.ok) {
      errors.push(`music_assistant.play_announcement: ${call.error ?? call.status}`);
    }

    if (message) lastSpokenMessage = message;

    const dt = Date.now() - t0;
    const renderTag = r.fromCache ? 'cached' : `rendered+${r.ttsRenderMs}ms`;
    if (errors.length === 0) {
      log(`broadcast: ${level} → ok in ${dt}ms (${cfg.targets.length} targets, ${renderTag}, ${r.sizeBytes ?? '?'} bytes${message ? ', +tts' : ''})`);
    } else {
      log(`broadcast: ${level} → ${errors.length} error(s) in ${dt}ms: ${errors.join('; ')}`);
    }
    return { ok: errors.length === 0, errors };
  };

  const messageFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    // No engine detection — Wyoming is always our TTS path. Return the
    // formatted message; the renderer hits Wyoming directly. If Wyoming
    // is offline the render fails cleanly and the broadcast logs an error.
    return buildAlertMessage(level, alerts);
  };

  /* ── tick — periodic check for condition transitions */
  let tickInFlight = false;
  const tick = async () => {
    if (stopped) return;
    cfg = loadBroadcastConfig();
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
    if (!transitioned && !newCrit) return;
    // Snapshot the transition state FIRST so a second arrival during an
    // in-flight broadcast doesn't re-fire (preserved from v0.9.49).
    prevLevel = level;
    prevCrit = crit;
    if (!cfg.enabled) return;
    if (level === 'yellow' && cfg.minSeverity === 'critical') return;
    if (level !== 'red' && inQuiet()) {
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
      const result = await runBroadcast(level, message);
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
      const message =
        level === 'red' ? 'Test broadcast. Red alert. This is only a test.' :
        level === 'yellow' ? 'Test broadcast. Yellow alert chime. This is only a test.' :
        'Test broadcast. All clear chime. This is only a test.';
      const r = await runBroadcast(level, message);
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
      lastRender: { ...lastRender },
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
      clearInterval(pruneInterval);
    },
  };
}
