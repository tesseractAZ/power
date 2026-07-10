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
import { aggregateFleetFlow, homeCoreCoverage } from './shp2Membership.js';
import type { CachedEntity } from './haStateCache.js';
import * as haStateCache from './haStateCache.js';
import type { AlarmPriority } from './alertPriority.js';

/** acIn at/above this (W) is positive proof the grid is energized AND drawing. */
export const GRID_IMPORT_WATTS = 5;
/** v0.36.0 — SHP2-metered whole-home grid power (wattInfo.gridWatt) at/above this
 *  (W) is positive proof the grid is energized AND carrying home load. This is the
 *  path the DPU acIn sum MISSES: grid that serves home loads directly through the
 *  panel without charging the DPUs (e.g. the SHP2 backstopping at the reserve
 *  floor). 25 W clears standby/measurement noise while still catching any real
 *  backstop (an at-floor transfer pulls kW). */
export const HOME_GRID_IMPORT_WATTS = 25;
/** fleetBatteryNet above +this (W) ⇒ the SHP2 backup pool is net-discharging (POSITIVE =
 *  discharging, per aggregateFleetFlow / the fleet_battery_net_watts sensor). v0.98.0 —
 *  previously keyed off chargeWattPower's sign, but that field is a non-negative configured
 *  charge LIMIT (~7.2 kW even while idle) and never went negative, so the guard was
 *  PERMANENTLY DEAD; it now reads the live per-pack net. Its effect is FLOOR-SCOPED (only
 *  distrusts a declared/gridSta grid AT/near the reserve floor — where a present grid must
 *  have transferred and the pool must stop draining, true for BOTH grid-priority and
 *  self-consumption SHP2 modes; away from the floor a discharging pool is normal cycling).
 *  It only matters for operators who DECLARE the grid present WITHOUT live import; the
 *  immediate primary defence is still a REAL grid sensor as GRID_PRESENCE_ENTITY (it flips
 *  off when the grid drops). For the islanded operator (declared=false) it is never consulted. */
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
  /** The grid import (W) observed on SHP2-bound cores (DPU ac_in path). */
  importWatts: number;
  /** v0.36.0 — SHP2 main-line grid power into the home (W) (wattInfo.gridWatt). */
  homeGridWatts: number;
  /** v0.89.0 — the SHP2's OWN direct grid-presence flag (pd303_mc.masterIncreInfo.gridSta,
   *  VALUE-1-ONLY, online-gated): true=Grid OK, false=islanded/out-of-spec, null=unknown.
   *  Additive backstop signal; observability + a future HA binary_sensor. */
  shp2GridConnected: boolean | null;
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
 * v0.36.0 — SHP2-metered whole-home grid power (wattInfo.gridWatt). This is the
 * SHP2's OWN authoritative measurement of grid power into the home; it captures
 * grid that serves home loads directly through the panel — the path
 * computeGridImportWatts (DPU ac_in only) misses. Unlike the DPU sum it needs NO
 * source-SN scoping (it is the SHP2's single main-line figure, not a per-DPU sum),
 * so there is no wall-charging-spare ambiguity to guard against.
 *
 * This closes the gap where an at-floor grid backstop was invisible to the
 * resolver: e.g. 2026-06-20 the SHP2 pulled +32.7 kWh of grid to carry the home
 * overnight at the 10% reserve floor while DPU ac_in read 0 — real, measured grid
 * flow the resolver could not see, leaving the floor downgrade leaning on the
 * declared toggle + the best-effort chargeWattPower discharge guard instead.
 * Only POSITIVE flow counts (gridWatt ≥ 0 by construction; a non-positive or
 * non-finite reading contributes nothing — never fabricates grid presence).
 */
export function computeHomeGridWatts(devices: Record<string, DeviceSnapshot>): number {
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  // v0.88.0 — FAIL-SAFE on an OFFLINE SHP2. `gridWatt` is the SHP2's OWN cloud-MQTT
  // reading; when the SHP2 goes cloud-offline its last value FREEZES in the
  // projection. An unguarded frozen-high gridWatt (e.g. the 7–8 kW it pulls to
  // carry the home at the reserve floor) would keep importLive=true → backstopping
  // =true → silently MUTE a REAL at-floor outage that begins during the offline
  // window. Mirror the `d.online` scoping the DPU ac_in path (computeGridImportWatts
  // above) already applies: an offline SHP2 contributes NO measured grid flow and
  // never fabricates grid presence from a stale sample. A genuinely online SHP2 with
  // bursty MQTT self-corrects on its next message, so this only suppresses the
  // frozen-offline case — it strictly HARDENS the alarm, never weakens it.
  if (!shp2 || !shp2.online) return 0;
  const w = shp2.projection.gridWatt ?? null;
  return w != null && Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * v0.89.0 — the SHP2's OWN direct grid-presence flag (projection.gridConnected, from
 * pd303_mc.masterIncreInfo.gridSta VALUE-1-ONLY). Returns true (Grid OK) / false
 * (islanded, or energized-but-out-of-spec) / null (unknown). FAIL-SAFE, mirroring
 * computeHomeGridWatts:
 *   - An OFFLINE SHP2 ⇒ null (its last gridSta FROZE; a stale "1" must never assert
 *     presence into an outage that begins during the offline window).
 *   - Field absent/unknown ⇒ null.
 * This is the panel's live line-sensing flag: it stays true through the zero-watt gaps
 * between the SHP2's 8 kW charge bursts (the exact false-critical this closes), and
 * drops to 0/2 the instant the utility is lost or goes out-of-spec (the SHP2 must
 * island in ms). It is only ever used ADDITIVELY (a positive present-signal), never a
 * sole mute gate, and — in resolveGridBackstop — is still SUBJECT to the pool-discharge
 * guard so a wedged/stale "connected" can't mute a net-discharging at-floor outage.
 */
export function computeShp2GridConnected(devices: Record<string, DeviceSnapshot>): boolean | null {
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  if (!shp2 || !shp2.online) return null;
  return shp2.projection.gridConnected ?? null;
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
  /** v0.36.0 — the SHP2 backup pool is AT (or within a hair of) its reserve
   *  floor. When true, a merely-DECLARED grid with NO measured flow on either
   *  path is NOT trusted to backstop (a stale "grid available" toggle must not
   *  mute a real at-floor outage). Away from the floor this is false and a
   *  flow-less declaration remains a valid backstop (grid available, not yet
   *  needed). Resolved from the SHP2 SoC vs backupReserveSoc in liveGridBackstop. */
  atReserveFloor?: boolean;
}

/** Pure resolver — unit-testable; no env / cache reads. */
export function resolveGridBackstop(input: GridBackstopInput): GridBackstop {
  const importWatts = computeGridImportWatts(input.devices);
  const homeGridWatts = computeHomeGridWatts(input.devices);
  // Grid flow is proven LIVE by EITHER measured path: DPU ac_in (grid charging the
  // SHP2-bound DPUs) or the SHP2 main gridWatt (grid serving home loads directly).
  // Either at/above its threshold is positive, unambiguous proof the grid is
  // energized AND carrying — independent of the declared toggle.
  const importLive = importWatts >= GRID_IMPORT_WATTS || homeGridWatts >= HOME_GRID_IMPORT_WATTS;

  // v0.89.0 — the SHP2's OWN direct grid-presence flag (gridSta=Grid OK), online-gated
  // + VALUE-1-ONLY (see computeShp2GridConnected). This is the burst-gap-immune signal:
  // it stays true through the zero-watt gaps between the SHP2's 8 kW charge bursts while
  // measured import momentarily reads 0, closing the between-burst false at-floor
  // critical. It is ADDITIVE only — a real outage drops gridSta (→ false/null) and this
  // term vanishes. It is NOT folded into importLive (which would unconditionally bypass
  // the poolDischarging guard); it gets its own term below that is still subject to
  // poolDischarging, so a wedged/stale "connected" can't mute a net-discharging outage.
  const shp2GridConnected = computeShp2GridConnected(input.devices);

  // Declared presence: a configured entity is authoritative (unknown ⇒ NOT
  // declared, the safe default); otherwise fall back to GRID_AVAILABLE.
  // v0.23.0 — a STALE configured entity (HA unreachable) is treated as UNKNOWN,
  // never its frozen last value, so it cannot replay a false "grid is fine".
  const entityUsable = input.gridEntityConfigured && !input.gridEntityStale;
  const entityPresent = entityUsable ? interpretGridEntity(input.gridEntity) : undefined;
  const declared = input.gridEntityConfigured
    ? entityPresent === true
    : input.gridAvailableFallback;

  const present = importLive || declared || shp2GridConnected === true;

  // Re-escalation guard: if presence is only DECLARED (not proven by live
  // import) and the SHP2 backup pool is clearly net-discharging, the declared
  // grid is NOT actually carrying the load → withhold the at-floor downgrade.
  // v0.98.0 (re-audit #1) — pool-discharge from the LIVE per-pack net flow
  // (aggregateFleetFlow.fleetBatteryNet, POSITIVE = discharging), the authoritative signal
  // behind the fleet_battery_net_watts sensor + the TUI header (v0.96.0), scoped to
  // SHP2-connected sources. Replaces `chargeWattPower < -POOL_DISCHARGE_WATTS`, which was
  // PERMANENTLY FALSE (chargeWattPower is the non-negative configured AC charge-rate LIMIT,
  // ~7.2 kW even while idle) — so this re-escalation guard was DEAD. index.ts already uses
  // the same `fleetBatteryNet > 50` discharge threshold for backup_charge_minutes.
  // v1.3.0 (audit rank 3) — COVERAGE-GATE the "not discharging" conclusion. fleetBatteryNet
  // sums only cloud-ONLINE, SHP2-connected DPUs, so a wedged home Core's real drain is
  // invisible: the sum can read under the 50 W threshold while the pool is genuinely
  // draining, and this guard would then hand a stale/declared grid the at-floor downgrade
  // it exists to withhold. We can PROVE discharge from a partial sum, but we can never
  // DISPROVE it. So an incomplete roster resolves toward "discharging" — the direction that
  // keeps a real at-floor emergency audible. The effect stays floor-scoped (below), so a
  // wedged Core away from the floor changes nothing.
  const poolCoverage = homeCoreCoverage(input.devices);
  const poolDischargingObserved = aggregateFleetFlow(input.devices).fleetBatteryNet > POOL_DISCHARGE_WATTS;
  const poolDischarging = poolDischargingObserved || !poolCoverage.complete;
  // FLOOR-SCOPED effect (matches this module's header intent): only DISTRUST a declared /
  // gridSta grid for pool-discharge AT/near the reserve floor — that is where a present grid
  // must have transferred and the pool must stop draining, true for BOTH grid-priority and
  // self-consumption SHP2 modes. Away from the floor a discharging pool is normal cycling and
  // must NOT withhold the backstop (else a self-consumption home would nuisance-escalate every
  // evening). The grid-presence entity flipping off remains the immediate primary defence.
  const poolDischargingAtFloor = poolDischarging && !!input.atReserveFloor;
  // v0.36.0 floor-hardening: AT the reserve floor, a merely-DECLARED grid with
  // NO measured flow on EITHER path (DPU ac_in AND SHP2 gridWatt both below
  // threshold) must NOT backstop — a stale "grid available" toggle must not mute
  // a real at-floor outage. This is FLOOR-ONLY: away from the floor (or with any
  // measured flow, or with live import) a flow-less declaration stays a valid
  // backstop (grid available, simply not yet needed), so the pre-floor
  // grid-available downgrade is preserved.
  const anyMeasuredFlow = importWatts > 0 || homeGridWatts > 0;
  const floorWithoutFlow = !!input.atReserveFloor && !anyMeasuredFlow;
  // v0.89.0 — the gridSta backstop term. EXEMPT from floorWithoutFlow (that guard exists
  // to distrust a stale operator toggle with no measured flow — but gridSta is a LIVE
  // measured device signal, and burst-gap immunity is the whole point). SUBJECT to
  // poolDischarging: a gridSta=Grid OK reading while the pool is net-discharging past the
  // floor is treated as NOT a real backstop (closes the frozen/wedged-connected mute).
  const gridStaBackstop = shp2GridConnected === true && !poolDischargingAtFloor;
  const backstopping =
    importLive || gridStaBackstop || (declared && !poolDischargingAtFloor && !floorWithoutFlow);

  const reason = importLive
    ? importWatts >= GRID_IMPORT_WATTS
      ? `live grid import ${Math.round(importWatts)} W (DPU ac-in)`
      : `live home-grid ${Math.round(homeGridWatts)} W (SHP2 main)`
    : gridStaBackstop
      ? 'SHP2 reports grid connected (gridSta=Grid OK)'
      : shp2GridConnected === true && poolDischargingAtFloor
        ? poolDischargingObserved
          ? 'SHP2 gridSta=Grid OK but backup pool still discharging at the reserve floor — not backstopping'
          : `SHP2 gridSta=Grid OK but only ${poolCoverage.reporting}/${poolCoverage.connected} home Cores are reporting at the reserve floor — pool drain unobservable, not backstopping`
        : declared
          ? floorWithoutFlow
            ? 'grid declared present but no measured grid flow at the reserve floor — not backstopping'
            : poolDischargingAtFloor
              ? poolDischargingObserved
                ? 'grid declared present but backup pool still discharging at the reserve floor — not backstopping'
                : `grid declared present but only ${poolCoverage.reporting}/${poolCoverage.connected} home Cores are reporting at the reserve floor — pool drain unobservable, not backstopping`
              : 'grid declared present'
          : input.gridEntityConfigured
            ? 'grid entity reports not present (or unknown)'
            : 'off-grid (no grid declared, no import)';

  return { present, backstopping, importLive, declared, importWatts, homeGridWatts, shp2GridConnected, reason };
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
  // v0.36.0 — derive whether the SHP2 backup pool is at (or within a hair of) its
  // reserve floor, so the resolver can apply the floor-hardening (a flow-less
  // declared grid is not trusted to backstop AT the floor). +1.5% slack absorbs
  // SoC quantisation / sample jitter so we don't oscillate right at the boundary.
  const shp2 = Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
  const backupFullCapWh = shp2?.projection.backupFullCapWh ?? null;
  const backupRemainWh = shp2?.projection.backupRemainWh ?? null;
  const socPct =
    backupFullCapWh != null && backupFullCapWh > 0 && backupRemainWh != null
      ? (backupRemainWh / backupFullCapWh) * 100
      : null;
  const reserveSoc = shp2?.projection.backupReserveSoc ?? null;
  const atReserveFloor = socPct != null && reserveSoc != null && socPct <= reserveSoc + 1.5;
  return resolveGridBackstop({
    devices,
    gridEntity: entityId ? haStateCache.getCachedEntity(entityId) : null,
    gridEntityConfigured: entityId.length > 0,
    gridAvailableFallback: process.env.GRID_AVAILABLE === 'true',
    gridEntityStale: stale,
    atReserveFloor,
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
