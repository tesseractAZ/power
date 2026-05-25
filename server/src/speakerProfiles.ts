/**
 * v0.9.29 — Per-speaker protocol profiles for synchronized broadcasts.
 *
 * Background. v0.9.18-23 broadcasts produced audio that played at wildly
 * different wall-clock times across the user's 6-speaker setup:
 *
 *     HomePod         : audio arrives ~2.0 sec after API call (AirPlay buffer)
 *     Sonos soundbar  : audio arrives ~0.3 sec after API call
 *     Cast speakers   : audio arrives ~1.0 sec after API call
 *     Thermostats     : audio arrives ~3-5 sec after API call (worst)
 *
 * Log analysis (local_ecoflow_panel_2026-05-25T22-51-28.932Z) confirmed
 * the spread: a single red-alert produced audio-file fetches at 0 ms,
 * 226 ms, 1.2 s, 35 s, 60 s, and 5 min (!) — the last few are speakers
 * pulling chunks long after the playback ended on other speakers.
 *
 * The fix is **staggered firing per protocol group**: speakers with the
 * longest buffer fire FIRST, then we wait for them to start playing
 * before firing faster speakers. Net effect: all speakers START PLAYING
 * within ~300 ms of each other in wall-clock time, even though the API
 * calls happen over a 2-second window.
 *
 * MA's `play_announcement` does the right thing within a single protocol
 * (all HomePods sync to each other) but CANNOT cross-sync HomePod ↔
 * Sonos ↔ Cast because each uses its own audio transport. So we have to
 * group by protocol ourselves.
 */

import { getAllStates } from './haService.js';

/** Speaker protocol families we know how to handle. */
export type SpeakerProtocol =
  | 'airplay'      // HomePod, Apple TV, AirPort Express → 2 sec buffer
  | 'sonos'        // Sonos → 0.3 sec buffer, native multi-room sync
  | 'cast'         // Chromecast, Google Home, Ecobee/Nest speakers → 1.0 sec
  | 'echo'         // Amazon Echo/Alexa via alexa_media → 0.5 sec
  | 'androidtv'    // Android TV → 0.8 sec
  | 'unknown';     // default, treated as 'cast'

export interface SpeakerProfile {
  entity_id: string;
  friendly_name: string;
  protocol: SpeakerProtocol;
  /** ms of audio buffer between API call and actual sound (empirically tuned). */
  bufferMs: number;
}

/**
 * Inferred from entity_id pattern + HA attribute hints (platform, model,
 * source_list, device_class). Sees the same data the v0.9.19 discover
 * endpoint uses; just maps the family label to a numeric buffer.
 *
 * Buffer values are tuned to match the operator's setup (2× HomePod, 1× Sonos
 * soundbar, 1× generic, 2× ecobee thermostats). They're conservative —
 * better to over-stagger by 100 ms than to leave speakers playing 1 s
 * apart.
 */
export function inferProtocol(entityId: string, attrs: Record<string, unknown>): SpeakerProtocol {
  const id = entityId.toLowerCase();
  const platform = String(attrs.platform ?? '').toLowerCase();
  const model = String((attrs as Record<string, unknown>).model ?? '').toLowerCase();
  const sourceList = Array.isArray(attrs.source_list) ? attrs.source_list.join(' ').toLowerCase() : '';
  const dt = String((attrs as Record<string, unknown>).device_class ?? '').toLowerCase();

  if (id.includes('sonos') || platform === 'sonos' || sourceList.includes('sonos')) return 'sonos';
  if (id.includes('homepod') || platform === 'homepod' || /homepod/.test(model) || id.includes('apple_tv') || platform === 'apple_tv') return 'airplay';
  // Ecobee/Nest thermostats expose themselves as `media_player.*_thermostat`
  // and use Cast under the hood. Sonos arc soundbars also use Cast under the
  // hood for some controls but they're tagged as `sonos` so they go above.
  if (platform === 'cast' || id.includes('chromecast') || id.includes('thermostat') || id.includes('nest') || id.includes('google') || id.includes('cast') || dt === 'speaker') return 'cast';
  if (platform === 'alexa_media' || id.includes('echo') || id.includes('alexa')) return 'echo';
  if (platform === 'androidtv' || id.includes('androidtv') || id.includes('android_tv')) return 'androidtv';
  return 'unknown';
}

/** Default buffer per protocol. Sized by empirical measurement in the
 *  v0.9.23 → v0.9.28 broadcast logs. */
export function defaultBufferMs(protocol: SpeakerProtocol): number {
  switch (protocol) {
    case 'airplay':   return 2000;
    case 'cast':      return 1000;
    case 'echo':      return 500;
    case 'androidtv': return 800;
    case 'sonos':     return 300;
    default:          return 1000;
  }
}

/**
 * Fetch the current HA media_player entities and profile each target.
 * If HA is unreachable (no SUPERVISOR_TOKEN), returns synthetic profiles
 * inferred from the entity_id alone — accurate enough for our naming
 * conventions but missing the model/platform hints.
 */
export async function profileTargets(targets: string[]): Promise<SpeakerProfile[]> {
  const all = await getAllStates();
  const lookup = new Map<string, Record<string, unknown>>();
  if (all) {
    for (const s of all) lookup.set(s.entity_id, s.attributes ?? {});
  }
  return targets.map((entity_id) => {
    const attrs = lookup.get(entity_id) ?? {};
    const protocol = inferProtocol(entity_id, attrs);
    const friendly = String(attrs.friendly_name ?? entity_id.replace(/^media_player\./, ''));
    return {
      entity_id,
      friendly_name: friendly,
      protocol,
      bufferMs: defaultBufferMs(protocol),
    };
  });
}

/**
 * Group profiled targets by protocol. Returned in "fire-first" order:
 * longest-buffer first (so they start playing at roughly the same
 * wall-clock time as the shortest-buffer group).
 */
export interface SpeakerGroup {
  protocol: SpeakerProtocol;
  bufferMs: number;
  targets: string[];
}

export function groupByProtocol(profiles: SpeakerProfile[]): SpeakerGroup[] {
  const byProto = new Map<SpeakerProtocol, SpeakerProfile[]>();
  for (const p of profiles) {
    let arr = byProto.get(p.protocol);
    if (!arr) { arr = []; byProto.set(p.protocol, arr); }
    arr.push(p);
  }
  const groups: SpeakerGroup[] = [];
  for (const [protocol, arr] of byProto) {
    groups.push({
      protocol,
      bufferMs: defaultBufferMs(protocol),
      targets: arr.map((p) => p.entity_id),
    });
  }
  // Longest buffer first — fires earliest so it has time to catch up.
  groups.sort((a, b) => b.bufferMs - a.bufferMs);
  return groups;
}

/**
 * Compute per-group fire delay relative to the call to runBroadcast().
 *
 *   group 0 (longest buffer): fire at 0 ms
 *   group 1 (next):           fire at (group0.bufferMs - group1.bufferMs)
 *   ...
 *
 * So all groups START PLAYING at approximately `group0.bufferMs` wall-clock.
 *
 * Returns the delay (ms from t0) at which to fire each group.
 */
export function scheduleStagger(groups: SpeakerGroup[]): Array<{ group: SpeakerGroup; fireAtMs: number }> {
  if (groups.length === 0) return [];
  const maxBuffer = groups[0].bufferMs;
  return groups.map((group) => ({
    group,
    fireAtMs: Math.max(0, maxBuffer - group.bufferMs),
  }));
}
