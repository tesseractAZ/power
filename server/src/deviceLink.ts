/**
 * Cloud-wedge vs real-outage device-link classifier.
 *
 * EcoFlow's cloud `/device/list` gives us a per-device `online` flag and NOTHING
 * about how to reach the device on the LAN (no IP, no MAC). So when the cloud
 * reports a device OFFLINE we cannot, from EcoFlow's data alone, tell the two
 * very different failure modes apart:
 *
 *   - CLOUD WEDGE — the device is alive and on the LAN, but its EcoFlow cloud
 *     session / MQTT pipe has wedged (a known recurring failure on this fleet:
 *     a Core can sit cloud-offline for >25 h while its LAN is perfectly fine).
 *     Telemetry resumes on its own once the cloud session re-establishes; a
 *     reflexive power-cycle just papers over the real cloud-side stall and risks
 *     interrupting a healthy home core.
 *   - REAL OUTAGE — the device is genuinely gone: no power, tripped breaker,
 *     dead WiFi/router. It is unreachable on the LAN too. THIS is the case a
 *     power-cycle / breaker / WiFi check actually addresses.
 *
 * The reachability signal must come from Home Assistant — the add-on does NOT do
 * raw ICMP itself (no new container capabilities). The operator configures one HA
 * "ping" binary_sensor per device IP (the `ping` integration, device_class
 * connectivity) and tells us, via ECOFLOW_DEVICE_REACHABILITY, which entity maps
 * to which device SN. The main loop reads those entity states each cycle and
 * feeds them here; the alarm engine then enriches the offline alert with the
 * classification.
 *
 * SAFETY POSTURE: this feature is purely ADDITIVE diagnostics. It NEVER changes
 * whether an alarm fires, its severity, its id, or the spare-gating — it only
 * enriches the offline alert's text/facts and publishes one diagnostic count.
 * When ECOFLOW_DEVICE_REACHABILITY is unset/empty the whole feature is dormant:
 * reachability resolves to 'unknown', the classifier returns 'unknown', no fact
 * is added, the hint is unchanged, and the wedge-count sensor publishes 0.
 *
 * This module mirrors gridState.ts: a pure, total, side-effect-free classifier
 * plus a small module-level cache the main-thread loop populates and the
 * (main-thread) alarm engine reads synchronously.
 */

/** Reachability of a device on the LAN, as read from its HA ping binary_sensor.
 *   - 'up'      — the entity reports connected/reachable.
 *   - 'down'    — the entity reports disconnected/unreachable.
 *   - 'unknown' — no entity configured for this SN, or its state is
 *                 unavailable/unknown/unparseable (the safe default). */
export type Reachability = 'up' | 'down' | 'unknown';

/** The cloud-vs-LAN device link classification.
 *   - 'online'      — EcoFlow cloud reports the device online (nothing to diagnose).
 *   - 'cloud_wedge' — cloud OFFLINE but the device is reachable on the LAN: an
 *                     EcoFlow cloud-session/MQTT wedge, not a power/network outage.
 *   - 'real_outage' — cloud OFFLINE and the device is NOT reachable on the LAN: a
 *                     genuine power/network outage.
 *   - 'unknown'     — cloud OFFLINE but we have no LAN reachability signal (no
 *                     entity configured / state unavailable). */
export type DeviceLink = 'online' | 'cloud_wedge' | 'real_outage' | 'unknown';

/**
 * PURE classifier — total, side-effect-free, no env / cache reads. Maps the two
 * inputs to the four link states:
 *
 *   cloudOnline=true                      → 'online'   (regardless of reachable)
 *   cloudOnline=false, reachable='up'     → 'cloud_wedge'
 *   cloudOnline=false, reachable='down'   → 'real_outage'
 *   cloudOnline=false, reachable='unknown'→ 'unknown'
 *
 * When the cloud says the device is online there is nothing to diagnose, so the
 * LAN reachability is irrelevant and we short-circuit to 'online'.
 */
export function classifyDeviceLink(cloudOnline: boolean, reachable: Reachability): DeviceLink {
  if (cloudOnline) return 'online';
  switch (reachable) {
    case 'up':
      return 'cloud_wedge';
    case 'down':
      return 'real_outage';
    default:
      return 'unknown';
  }
}

/**
 * Parse ECOFLOW_DEVICE_REACHABILITY — a JSON object string mapping device SN to
 * the HA binary_sensor entity_id that pings that device's LAN IP, e.g.
 *   {"GBC0314...":"binary_sensor.core1_lan","GBC0482...":"binary_sensor.core2_lan"}
 *
 * Tolerant by design: an empty/unset/malformed value, or a non-object / wrong
 * value-type JSON, yields {} (the feature simply stays dormant). Only string→
 * non-empty-string entries survive, so a stray null/number/array can't poison the
 * map.
 */
/** v0.73.0 — a valid Home Assistant entity_id: `domain.object_id`, lower-snake on
 *  both sides (e.g. `binary_sensor.core1_lan`). Anything else (path separators,
 *  spaces, uppercase, missing dot) is rejected by deviceReachabilityEntities. */
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function deviceReachabilityEntities(): Record<string, string> {
  const raw = (process.env.ECOFLOW_DEVICE_REACHABILITY ?? '').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON ⇒ dormant
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [sn, entityId] of Object.entries(parsed as Record<string, unknown>)) {
    const key = typeof sn === 'string' ? sn.trim() : '';
    const val = typeof entityId === 'string' ? entityId.trim() : '';
    // v0.73.0 (finding #2) — only accept a well-formed HA entity_id (domain.object_id,
    // lower-snake). This is defence-in-depth alongside getEntityState's encodeURIComponent:
    // it drops a malformed/hostile value (path separators, spaces, injection attempts)
    // here, before it ever reaches an HA request, while keeping every valid entry.
    if (key !== '' && ENTITY_ID_RE.test(val)) out[key] = val;
  }
  return out;
}

/** True when at least one device has a reachability entity configured. When false
 *  the entire feature is dormant (no fetch, no facts, no hint change, sensor=0). */
export function hasReachabilityConfig(): boolean {
  return Object.keys(deviceReachabilityEntities()).length > 0;
}

/**
 * Module-level reachability cache, mirroring gridState's haStateCache style: the
 * main-thread poll loop writes the latest reachability per SN, and the (also
 * main-thread) alarm engine reads it synchronously while building the offline
 * alert. A missing SN reads 'unknown' — the safe default that yields a 'unknown'
 * classification (no enrichment) rather than a fabricated up/down.
 */
const reachabilityBySn = new Map<string, { reachable: Reachability; ts: number }>();

/** v0.73.0 (finding #3) — staleness guard, mirroring gridState's GRID_ENTITY_MAX_AGE_MS.
 *  A reachability reading older than this decays to 'unknown' rather than replaying a
 *  frozen last-known value: when the HA poll stalls (Supervisor wedge / token expiry /
 *  the entity goes stale) the safe answer is "we don't know", not a stale 'up'/'down'
 *  that could mis-classify an offline device's cause. The 30 s poll refreshes well
 *  inside this, so a live sensor never decays; only a since-frozen one does. 150 s ≈ 5×
 *  the poll interval, so a single missed tick can't trip it. Env-tunable. */
export const REACHABILITY_MAX_AGE_MS = Math.max(0, Number(process.env.REACHABILITY_MAX_AGE_MS ?? 150_000));

export function setDeviceReachability(sn: string, reachable: Reachability, ts: number = Date.now()): void {
  reachabilityBySn.set(sn, { reachable, ts });
}

export function getDeviceReachability(sn: string, now: number = Date.now()): Reachability {
  const entry = reachabilityBySn.get(sn);
  if (entry == null) return 'unknown';
  // A frozen reading older than the TTL decays to 'unknown' (safe default → no
  // enrichment / 'unknown' classification), never a stale fabricated up/down.
  if (now - entry.ts > REACHABILITY_MAX_AGE_MS) return 'unknown';
  return entry.reachable;
}

/**
 * Interpret a raw HA entity state string into 'up' / 'down' / 'unknown'. Follows
 * the HA ping binary_sensor convention (device_class connectivity): state 'on'
 * means CONNECTED (reachable). Also accepts the common home/connected/true forms
 * (and their inverses) so a device_tracker or template entity works too.
 * unavailable / unknown / empty / unrecognised ⇒ 'unknown' (safe default).
 */
export function interpretReachabilityState(state: string | null | undefined): Reachability {
  const s = (state ?? '').trim().toLowerCase();
  if (s === '' || s === 'unavailable' || s === 'unknown' || s === 'none') return 'unknown';
  if (['on', 'home', 'connected', 'true', 'up', 'reachable', 'online', 'yes'].includes(s)) return 'up';
  if (['off', 'not_home', 'disconnected', 'false', 'down', 'unreachable', 'offline', 'no'].includes(s)) return 'down';
  return 'unknown';
}

/**
 * Count the devices currently classified 'cloud_wedge' — cloud-offline but
 * reachable on the LAN. Pure: takes the device list and a reachability lookup so
 * it is unit-testable and can be driven from either the live cache (default) or a
 * fixture. A device the cloud reports ONLINE never counts (classifier short-
 * circuits to 'online'). When no reachability is configured every offline device
 * resolves to 'unknown', so the count is 0 (dormant).
 */
export function countCloudWedges(
  devices: Array<{ sn: string; online: boolean }>,
  reachableOf: (sn: string) => Reachability = getDeviceReachability,
): number {
  let n = 0;
  for (const d of devices) {
    if (classifyDeviceLink(d.online, reachableOf(d.sn)) === 'cloud_wedge') n++;
  }
  return n;
}
