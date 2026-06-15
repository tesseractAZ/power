/**
 * v0.23.0 — Grid backstop resolver.
 *
 * The SHP2 cloud telemetry exposes NO grid-presence field: no utility line
 * voltage, no transfer/bypass state, no on-grid/island flag. The only on-device
 * grid signal is grid IMPORT watts (the DPU `acInWatts` on SHP2-bound cores),
 * and that reads ZERO whenever PV/battery covers the load even when the mains
 * are perfectly live. So "is the grid energized, even if unused" cannot be read
 * from the SHP2 — it must come from an operator-provided Home Assistant entity
 * (GRID_PRESENCE_ENTITY), with live grid import as positive corroboration.
 *
 * This module answers ONE question for the floor / runway / SoC alarms: is the
 * grid backstopping the home right now, such that the backup pool reaching its
 * reserve floor merely transfers to mains (a non-event) rather than risking a
 * local outage (a real emergency)?
 *
 * SAFETY POSTURE (do not weaken):
 *   - Default to NOT present / NOT backstopping whenever the signal is missing,
 *     unavailable, or unknown. A false "grid is fine" that silenced a real
 *     off-grid emergency is the one outcome we refuse; an extra alert when grid
 *     was actually fine is merely annoying.
 *   - The downgrade requires a POSITIVE signal (live import, an entity that
 *     reads present, or the GRID_AVAILABLE standing declaration).
 *   - `backstopping` (the at-the-floor downgrade) additionally withholds when
 *     the declared grid is demonstrably NOT carrying the load — i.e. the SHP2
 *     backup pool is still net-discharging. At the reserve floor a present grid
 *     would have transferred and the pool would stop draining; if it keeps
 *     draining, the declared grid is not really there → stay critical.
 */

import type { DeviceSnapshot } from './snapshot.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import type { CachedEntity } from './haStateCache.js';
import * as haStateCache from './haStateCache.js';
import type { AlarmPriority } from './alertPriority.js';

/** acIn at/above this (W) is positive proof the grid is energized AND drawing. */
export const GRID_IMPORT_WATTS = 5;
/** chargeWattPower below −this (W) ⇒ the backup pool is net-discharging.
 *  Live telemetry confirms positive = charging (observed +7200 W while SoC rose).
 *  The negative = discharging direction is ASSUMED, not yet verified against a
 *  live discharge sample — so the re-escalation guard that uses it is BEST-EFFORT.
 *  It only matters for operators who DECLARE the grid present (entity/GRID_AVAILABLE)
 *  WITHOUT live import; the primary defence for those operators is a REAL grid
 *  sensor as GRID_PRESENCE_ENTITY (it flips off when the grid drops). For the
 *  islanded operator (declared=false) this constant is never consulted. */
export const POOL_DISCHARGE_WATTS = 50;
/** v0.23.0 — a configured grid-presence entity older than this (ms) is treated
 *  as UNKNOWN, not its last-known value. When HA is unreachable (Pi reboot /
 *  network partition / token expiry — exactly when the grid may be down), a
 *  failed refresh leaves the cache frozen; replaying a stale "on" is the one
 *  false "grid is fine" the safety posture forbids. 120 s ≈ 4× the 30 s cache
 *  TTL and 6× the 20 s alert-eval refresh, so a healthy system never trips it. */
export const GRID_ENTITY_MAX_AGE_MS = 120_000;

export interface GridBackstop {
  /** Grid is energized (present) per the best available signal. */
  present: boolean;
  /** Grid is actively backstopping the home — safe to downgrade the floor to an
   *  advisory. Stricter than `present`: also requires the grid to be carrying
   *  the load (proven by live import, or the pool not net-discharging). */
  backstopping: boolean;
  /** Live grid import detected — positive, unambiguous proof grid is energized. */
  importLive: boolean;
  /** Declared present via the HA entity or GRID_AVAILABLE (not via live import). */
  declared: boolean;
  /** The grid import (W) observed on SHP2-bound cores. */
  importWatts: number;
  /** Human-readable reason, for status payloads / logs / alert detail. */
  reason: string;
}

/**
 * Sum AC-input watts across the SHP2-bound DPU cores (the house's grid path).
 * A spare DPU plugged into a wall to self-charge must NOT register as house grid
 * power, so we scope STRICTLY to the SHP2's connected source SNs.
 *
 * v0.23.0 safety fix: unlike the cosmetic off-grid detector in alerts.ts (which
 * falls back to summing ALL DPUs when source SNs are unknown), the backstop
 * decision must NOT do that. If the SHP2's source SNs are unavailable (e.g. a
 * partial /quota/all that returns the backup SoC subtree but omits the pd303_mc
 * source subtree), summing all DPUs would let a wall-charging spare's acIn
 * masquerade as house grid import and wrongly downgrade a real off-grid floor
 * emergency. With no source identity we therefore report 0 import — the resolver
 * then treats the grid as NOT live unless separately declared.
 */
export function computeGridImportWatts(devices: Record<string, DeviceSnapshot>): number {
  const list = Object.values(devices);
  const dpus = list.filter((d) => d.projection?.kind === 'dpu') as Array<
    DeviceSnapshot & { projection: DpuProjection }
  >;
  const shp2 = list.find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const sourceSns = new Set(
    (shp2?.projection.sources ?? []).map((s) => s.sn).filter((sn): sn is string => !!sn),
  );
  // No SHP2 source identity → cannot attribute import to the house grid path →
  // fail safe to 0 (never let an unscoped DPU sum silence a floor emergency).
  if (sourceSns.size === 0) return 0;
  return dpus
    .filter((d) => d.online && sourceSns.has(d.sn))
    .reduce((s, d) => s + (d.projection.acInWatts ?? 0), 0);
}

/**
 * Interpret a Home Assistant grid-presence entity state into present(true) /
 * absent(false) / unknown(null). Supports the realistic entity kinds:
 *   - binary_sensor / input_boolean / switch: on/true/home/connected/closed → present
 *   - a grid VOLTAGE sensor (numeric): > 50 (volts) → present
 *   - unavailable / unknown / empty → null (unknown ⇒ safe default upstream)
 */
export function interpretGridEntity(e: CachedEntity | null): boolean | null {
  if (!e) return null;
  const s = (e.state ?? '').trim().toLowerCase();
  if (s === '' || s === 'unavailable' || s === 'unknown' || s === 'none') return null;
  // Numeric (e.g. a line-voltage sensor): treat a meaningful magnitude as present.
  const n = Number(s);
  if (Number.isFinite(n)) return Math.abs(n) > 50;
  if (['on', 'true', 'home', 'connected', 'present', 'online', 'energized', 'grid', 'closed', 'yes', 'up'].includes(s))
    return true;
  if (['off', 'false', 'away', 'disconnected', 'absent', 'offline', 'islanded', 'island', 'open', 'no', 'down'].includes(s))
    return false;
  return null; // unrecognised ⇒ unknown ⇒ safe default
}

export interface GridBackstopInput {
  devices: Record<string, DeviceSnapshot>;
  /** Cached state of GRID_PRESENCE_ENTITY, or null if unset / not yet cached. */
  gridEntity: CachedEntity | null;
  /** True when GRID_PRESENCE_ENTITY is configured (vs. relying on the fallback). */
  gridEntityConfigured: boolean;
  /** GRID_AVAILABLE standing declaration — the coarse fallback when no entity. */
  gridAvailableFallback: boolean;
  /** v0.23.0 — the cached entity is older than GRID_ENTITY_MAX_AGE_MS (HA
   *  unreachable). A stale entity is treated as UNKNOWN (not its frozen value)
   *  so a stale "on" can't silence a real outage. */
  gridEntityStale?: boolean;
}

/** Pure resolver — unit-testable; no env / cache reads. */
export function resolveGridBackstop(input: GridBackstopInput): GridBackstop {
  const importWatts = computeGridImportWatts(input.devices);
  const importLive = importWatts >= GRID_IMPORT_WATTS;

  // Declared presence: a configured entity is authoritative (unknown ⇒ NOT
  // declared, the safe default); otherwise fall back to GRID_AVAILABLE.
  // v0.23.0 — a STALE configured entity (HA unreachable) is treated as UNKNOWN,
  // never its frozen last value, so it cannot replay a false "grid is fine".
  const entityUsable = input.gridEntityConfigured && !input.gridEntityStale;
  const entityPresent = entityUsable ? interpretGridEntity(input.gridEntity) : undefined;
  const declared = input.gridEntityConfigured
    ? entityPresent === true
    : input.gridAvailableFallback;

  const present = importLive || declared;

  // Re-escalation guard: if presence is only DECLARED (not proven by live
  // import) and the SHP2 backup pool is clearly net-discharging, the declared
  // grid is NOT actually carrying the load → withhold the at-floor downgrade.
  const shp2 = Object.values(input.devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const cwp = shp2?.projection.chargeWattPower ?? null;
  const poolDischarging = cwp != null && cwp < -POOL_DISCHARGE_WATTS;
  const backstopping = importLive || (declared && !poolDischarging);

  const reason = importLive
    ? `live grid import ${Math.round(importWatts)} W`
    : declared
      ? poolDischarging
        ? 'grid declared present but backup pool still discharging — not backstopping'
        : 'grid declared present'
      : input.gridEntityConfigured
        ? 'grid entity reports not present (or unknown)'
        : 'off-grid (no grid declared, no import)';

  return { present, backstopping, importLive, declared, importWatts, reason };
}

/** Live wrapper: reads GRID_PRESENCE_ENTITY / GRID_AVAILABLE from env and the
 *  HA state cache. The caller is responsible for keeping the cache warm
 *  (haStateCache.refreshIfStale) when a grid entity is configured. */
export function gridPresenceEntityId(): string {
  return (process.env.GRID_PRESENCE_ENTITY ?? '').trim();
}

export function liveGridBackstop(devices: Record<string, DeviceSnapshot>): GridBackstop {
  const entityId = gridPresenceEntityId();
  // v0.23.0 — getCacheAgeMs reports the age since the last SUCCESSFUL HA fetch
  // (a failed refresh does not advance it), so it's the right staleness signal:
  // if HA has been unreachable beyond the bound, the cached entity is treated as
  // UNKNOWN rather than replaying a frozen last value.
  const stale = entityId.length > 0 && haStateCache.getCacheAgeMs() > GRID_ENTITY_MAX_AGE_MS;
  return resolveGridBackstop({
    devices,
    gridEntity: entityId ? haStateCache.getCachedEntity(entityId) : null,
    gridEntityConfigured: entityId.length > 0,
    gridAvailableFallback: process.env.GRID_AVAILABLE === 'true',
    gridEntityStale: stale,
  });
}

/**
 * Downgrade an audible alarm priority when the grid is backstopping: a low
 * backup pool is a non-event (it just transfers to mains), so the emergency
 * tiers (high/critical) collapse to a low advisory. Medium/low are left intact
 * (they are already non-emergency status announcements).
 */
export function downgradePriorityForGrid(p: AlarmPriority, backstopping: boolean): AlarmPriority {
  return backstopping && (p === 'critical' || p === 'high') ? 'low' : p;
}
