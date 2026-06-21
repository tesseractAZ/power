/**
 * v0.9.74 — SHP2 membership filter for fleet-capacity aggregations.
 *
 * the operator's setup: 5 EcoFlow Delta Pro Ultra cores on the EcoFlow Cloud
 * account, but only 3 wired into the home's SHP2 (Smart Home Panel).
 * Cores 4 + 5 are spares — they can charge on the bench / off a wall
 * outlet and report telemetry, but they CAN'T deliver energy into the
 * home until they're physically connected to the (forthcoming second)
 * SHP2.
 *
 * Before this version, every "fleet" aggregation (lifetime kWh, runway,
 * backup-pool capacity, peer-pack outlier baseline, MQTT Discovery
 * sensor values, HA Energy Dashboard counters) summed across all 5
 * cores. That overstated:
 *   - Lifetime PV / battery charge / discharge by the spares' share
 *     (which was being recorded to the persistent counters since v0.8.0)
 *   - Current fleet PV / total-in / total-out watts shown on HA tiles
 *   - Degradation peer-comparison baseline (a spare's odd pack got
 *     compared against the live fleet)
 *
 * Fix: a single helper that resolves the SHP2's `sources` list into a
 * Set<sn> of "this DPU actually contributes to the home power bus,"
 * and every aggregation passes its DPUs through `isShp2Connected()`.
 *
 * ### Fallback behavior
 *
 * When the SHP2 hasn't been observed yet (e.g. cold boot, SHP2 offline,
 * or this is a user with no SHP2 at all — DPU-only setups exist),
 * `shp2ConnectedDpuSns` returns an empty Set. In that case
 * `isShp2Connected` returns TRUE for any SN — we don't filter when we
 * have no membership information, because that would zero out every
 * dashboard tile for users who never had an SHP2.
 *
 * This is safer than the alternative (returning FALSE when membership
 * is unknown), but means the filter is silently ineffective for users
 * without an SHP2. For the operator's setup (always has an SHP2 connected)
 * this isn't an issue.
 */

import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection } from './ecoflow/project.js';

/**
 * Return the set of DPU SNs that are physically wired into the SHP2 —
 * i.e. devices whose energy reports should count toward "fleet" totals.
 *
 * Returns an empty Set when no SHP2 is present in the snapshot. Callers
 * should pass that empty Set through `isShp2Connected` rather than
 * treating empty as "nothing connected" (see fallback behavior above).
 */
export function shp2ConnectedDpuSns(devices: Record<string, DeviceSnapshot>): Set<string> {
  const list = Object.values(devices);
  const shp2 = list.find((d) => d.projection?.kind === 'shp2');
  if (!shp2 || shp2.projection?.kind !== 'shp2') return new Set();
  const proj = shp2.projection as Shp2Projection;
  return new Set(
    proj.sources
      .filter((s) => s.isConnected && s.sn)
      .map((s) => s.sn as string),
  );
}

/**
 * True iff `sn` should be included in fleet aggregations.
 *
 * IMPORTANT — fallback semantics: when `connected` is empty (no SHP2
 * observed), this returns true for every SN. That's the safe-default
 * behavior for DPU-only setups; see module docstring.
 *
 * For the operator's setup the SHP2 is always present, so this returns true
 * only for Cores 1, 2, 3 (slots 1-3) and false for Cores 4, 5.
 */
export function isShp2Connected(sn: string, connected: Set<string>): boolean {
  if (connected.size === 0) return true;
  return connected.has(sn);
}

/**
 * v0.16.4 — Designated bench spares (Core 4 + Core 5).
 *
 * These two DPUs are intentionally kept powered down and are NOT wired into
 * the home's SHP2. Their EcoFlow-Cloud "offline" / stale-telemetry state is an
 * EXPECTED steady state — not an event — so the connectivity alert for them is
 * emitted non-annunciating (visible in the UI, but no chime / push / broadcast;
 * see alerts.ts). This is the single source of truth for "designated bench
 * spare," replacing the duplicated `EXCLUDED_SPARE_SNS` that previously lived in
 * repairIssues.ts.
 *
 * Why an explicit SN allowlist (not the dynamic isConnected membership) is the
 * SAFETY FLOOR for the zombie gate: a genuine home core (1/2/3) — even one that
 * is faulted or unplugged and has therefore dropped out of the SHP2's
 * `isConnected` sources — must NEVER have its real offline alarm muted. Because
 * a home core's SN is never in this set, it can never be misclassified as a
 * spare. Pair this floor with a POSITIVE connected-source check
 * (`shp2ConnectedDpuSns(...).has(sn)`) to re-arm a spare the moment it is wired
 * into an SHP2 and starts reporting as a connected source.
 */
export const SPARE_DPU_SNS: ReadonlySet<string> = new Set([
  'Y711ZABA9H3T0489', // Core 4
  'Y711ZAB59G9P0090', // Core 5
]);

/**
 * v0.40.1 — a connected SHP2 source slot whose underlying DPU is itself
 * EcoFlow-cloud-offline (its OWN telemetry is stale), even though the SHP2 still
 * reports the slot as connected and counts its battery in the backup pool.
 *
 * OBSERVABILITY ONLY — does NOT change any capacity or alarm math. The backup
 * pool (backupFullCapWh / backupRemainWh / backupBatPercent) is read straight
 * from the SHP2's own aggregate quota (`backupIncreInfo.*`), NOT summed from
 * per-slot data, so it stays correct and fresh while the SHP2 is online,
 * regardless of any DPU's cloud link. We deliberately do NOT subtract a stale
 * slot from the pool: the battery is physically wired and contributing, and the
 * reserve-floor alarm derives from that capacity (gridState.ts) — dropping it
 * would falsely LOWER the reserve % and could FALSE-ESCALATE the floor alarm. A
 * genuinely UNPLUGGED core drops out of the SHP2's `isConnected` on its own.
 *
 * True iff: the slot is connected, maps to a known DPU device that is currently
 * offline, and is not a designated bench spare (whose offline state is an
 * EXPECTED steady state, never flagged — mirrors the zombie-alert gating).
 */
export function isSourceDpuStale(
  source: { isConnected: boolean; sn: string | null },
  devices: Record<string, DeviceSnapshot>,
): boolean {
  if (!source.isConnected || !source.sn) return false;
  if (SPARE_DPU_SNS.has(source.sn)) return false;
  const dpu = devices[source.sn];
  return dpu != null && dpu.online === false;
}
