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
import { callHaService, isSupervised } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';

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
    ttsService: emptyToNull(process.env.BROADCAST_TTS_SERVICE),
    ttsLanguage: emptyToNull(process.env.BROADCAST_TTS_LANGUAGE),
    sonosRestore: process.env.BROADCAST_SONOS_RESTORE !== 'false',
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
  /** Force a test broadcast (bypasses every gate). */
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[] }>;
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
}

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

  const inQuiet = (): boolean => {
    if (!cfg.quietHours) return false;
    return inQuietWindow(new Date(), cfg.quietHours);
  };

  /**
   * Run one broadcast — set volume, play klaxon WAV, optionally TTS.
   * Returns a per-target outcome list for the status endpoint.
   */
  const runBroadcast = async (level: ConditionLevel, message: string | null): Promise<{ ok: boolean; errors: string[] }> => {
    const errors: string[] = [];
    if (!supervised) {
      errors.push('not supervised');
      return { ok: false, errors };
    }
    if (cfg.targets.length === 0) {
      errors.push('no targets configured');
      return { ok: false, errors };
    }
    const wav = `${cfg.audioBase}/audio/${level === 'red' ? 'red-alert' : level === 'yellow' ? 'yellow-alert' : 'all-clear'}.wav`;
    const boatswain = `${cfg.audioBase}/audio/boatswain.wav`;

    // 1. Snapshot Sonos state so we don't lose what was playing.
    const sonosTargets = cfg.targets.filter((t) => t.includes('sonos') || /\bsonos\b/i.test(t));
    if (cfg.sonosRestore && sonosTargets.length > 0) {
      const r = await callHaService('sonos', 'snapshot', { entity_id: sonosTargets, with_group: true });
      if (!r.ok) errors.push(`sonos.snapshot: ${r.error ?? r.status}`);
    }

    // 2. Set volume on every target.
    const volRes = await callHaService('media_player', 'volume_set', {
      entity_id: cfg.targets,
      volume_level: cfg.volume,
    });
    if (!volRes.ok) errors.push(`volume_set: ${volRes.error ?? volRes.status}`);

    // 3. Play boatswain whistle for shipwide-address authenticity (only
    //    when we have a TTS to follow it — otherwise the klaxon is the
    //    whole message and a pre-roll would be redundant noise).
    if (cfg.ttsService && message) {
      const bRes = await callHaService('media_player', 'play_media', {
        entity_id: cfg.targets,
        media_content_id: boatswain,
        media_content_type: 'music',
        announce: true,
      });
      if (!bRes.ok) errors.push(`boatswain: ${bRes.error ?? bRes.status}`);
      // Brief gap so the boatswain whistle clears before the klaxon.
      await sleep(1500);
    }

    // 4. Play the level-appropriate klaxon / chime.
    const kRes = await callHaService('media_player', 'play_media', {
      entity_id: cfg.targets,
      media_content_id: wav,
      media_content_type: 'music',
      announce: true,
    });
    if (!kRes.ok) errors.push(`play_media: ${kRes.error ?? kRes.status}`);

    // 5. Optional TTS announcement.
    if (cfg.ttsService && message) {
      // Wait for the klaxon to clear before the voice. 3.5s covers the
      // red-alert clip (~3s) with a small margin.
      await sleep(level === 'red' ? 3500 : 1500);
      const [domain, service] = cfg.ttsService.split('.');
      const data: Record<string, unknown> = {
        entity_id: cfg.targets,
        message,
      };
      if (cfg.ttsLanguage) {
        data.language = cfg.ttsLanguage;
      }
      const tRes = await callHaService(domain, service, data);
      if (!tRes.ok) errors.push(`tts: ${tRes.error ?? tRes.status}`);
    }

    // 6. Restore Sonos state (wait for our audio to finish first).
    if (cfg.sonosRestore && sonosTargets.length > 0) {
      const settleMs = (cfg.ttsService && message ? 8000 : (level === 'red' ? 3500 : 1500));
      await sleep(settleMs);
      const r = await callHaService('sonos', 'restore', { entity_id: sonosTargets, with_group: true });
      if (!r.ok) errors.push(`sonos.restore: ${r.error ?? r.status}`);
    }

    return { ok: errors.length === 0, errors };
  };

  /**
   * Build a short situational TTS message for the given condition.
   */
  const messageFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    if (!cfg.ttsService) return null;
    if (level === 'red') {
      const crit = alerts.find((a) => a.severity === 'critical');
      const what = crit ? `, ${crit.title}` : '';
      return `Red alert. Red alert. Critical condition${what}.`;
    }
    if (level === 'yellow') {
      const warn = alerts.find((a) => a.severity === 'warning');
      const what = warn ? `, ${warn.title}` : '';
      return `Yellow alert. Caution${what}.`;
    }
    return 'All clear. All stations report normal.';
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
    lastOutcome = result.ok ? 'success' : (result.errors.length === cfg.targets.length + 5 ? 'failure' : 'partial');
    lastErrors = result.errors;
    if (result.errors.length > 0) {
      log(`broadcast: errors → ${result.errors.join('; ')}`);
    }
    prevLevel = level;
    prevCrit = crit;
  };

  const tickInterval = setInterval(() => { tick().catch((e) => log(`broadcast: tick failed: ${e?.message ?? e}`)); }, 10_000);
  tickInterval.unref();

  return {
    test: async (level: ConditionLevel = 'red') => {
      cfg = loadBroadcastConfig();
      const message =
        level === 'red' ? 'Test broadcast. Red alert klaxon. This is only a test.' :
        level === 'yellow' ? 'Test broadcast. Yellow alert chime. This is only a test.' :
        'Test broadcast. All clear chime. This is only a test.';
      const r = await runBroadcast(level, cfg.ttsService ? message : null);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = r.ok ? 'success' : 'partial';
      lastErrors = r.errors;
      return { ok: r.ok, messages: r.errors };
    },
    config: () => cfg,
    status: () => ({
      supervised,
      enabled: cfg.enabled,
      targetCount: cfg.targets.length,
      lastBroadcastAt,
      lastLevel,
      lastOutcome,
      lastErrors,
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
