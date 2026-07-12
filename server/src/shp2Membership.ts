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
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';

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
  // v0.98.0 — `?? []` so a partial SHP2 projection with no sources[] subtree (e.g. a
  // /quota/all that returns the backup SoC but omits pd303_mc sources) can't throw. This
  // matches computeGridImportWatts's existing guard and matters now that aggregateFleetFlow
  // (which calls this) is also reached from the grid-backstop resolver.
  return new Set(
    (proj.sources ?? [])
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
 * SAFETY FLOOR for the cloud-offline gate: a genuine home core (1/2/3) — even one that
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
 * v0.52.0 — single source of truth for "this SN is a designated bench spare
 * whose EcoFlow-offline state is the EXPECTED steady state" (so its
 * connectivity / learned / forecast alerts are emitted non-annunciating).
 *
 * True iff: the SN is in the SPARE_DPU_SNS safety floor AND it is NOT currently
 * a connected SHP2 source. The positive connected-source check (the `!has`
 * below) is what re-arms a spare the instant it is wired into an SHP2 and starts
 * reporting as a connected source — exactly mirroring the gate that previously
 * lived as a local closure in alerts.ts and the `mutedSpares` list in
 * alertMonitor.ts.
 *
 * Overloaded so a hot loop (alerts.ts) can pass an already-computed connected
 * Set and avoid rescanning `devices` per call, while a one-shot caller can pass
 * the raw devices Record and let the helper resolve membership once.
 */
export function isExpectedOfflineSpare(sn: string, connected: Set<string>): boolean;
export function isExpectedOfflineSpare(sn: string, devices: Record<string, DeviceSnapshot>): boolean;
export function isExpectedOfflineSpare(
  sn: string,
  connectedOrDevices: Set<string> | Record<string, DeviceSnapshot>,
): boolean {
  const connected =
    connectedOrDevices instanceof Set ? connectedOrDevices : shp2ConnectedDpuSns(connectedOrDevices);
  return SPARE_DPU_SNS.has(sn) && !connected.has(sn);
}

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
 * True iff: the slot is connected, maps to a known DPU device that is marked offline
 * (its `DeviceSnapshot.online` is the LAST-KNOWN cloud state, which can lag a stale
 * EcoFlow `/device/list` session — so `dpuStale` is a best-effort hint, not an
 * authoritative real-time cloud-presence signal), and is not a designated bench spare
 * (whose offline state is an EXPECTED steady state, never flagged — mirrors the
 * cloud-offline alert gating).
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

/**
 * v0.52.0 — the SHP2 device (the home's grid interconnect), or undefined.
 * VERBATIM `Object.values(devices).find((d) => d.projection?.kind === 'shp2')`
 * that was repeated at ~5 index.ts call sites. Callers keep any post-find
 * `&& d.projection?.kind === 'shp2'` re-narrow as-is.
 */
export function findShp2(
  devices: Record<string, DeviceSnapshot>,
): (DeviceSnapshot & { projection: Shp2Projection }) | undefined {
  return Object.values(devices).find((d) => d.projection?.kind === 'shp2') as
    | (DeviceSnapshot & { projection: Shp2Projection })
    | undefined;
}

/**
 * v0.52.0 — the currently-ONLINE DPU cores. VERBATIM
 * `Object.values(devices).filter((d) => d.projection?.kind === 'dpu' && d.online)`
 * repeated at ~4 index.ts call sites. NOTE the `&& d.online` predicate — this is
 * the live-fleet selector, distinct from analytics' all-DPUs membership filter.
 */
export function onlineDpus(
  devices: Record<string, DeviceSnapshot>,
): Array<DeviceSnapshot & { projection: DpuProjection }> {
  return Object.values(devices).filter(
    (d) => d.projection?.kind === 'dpu' && d.online,
  ) as Array<DeviceSnapshot & { projection: DpuProjection }>;
}

/**
 * v0.52.0 — the live fleet power-flow aggregate, shared by the REST
 * `/api/ha-state` handler (index.ts) and the MQTT-discovery `buildState`
 * (mqttDiscovery.ts), which previously kept two BYTE-IDENTICAL copies of this
 * loop in hand-maintained sync (the "match /api/ha-state" comment).
 *
 * Returns RAW, un-rounded sums — both call sites apply their own `Math.round`
 * at emission, and the raw `fleetBatteryNet` feeds the ±50 W charge/discharge
 * timer gates, so rounding MUST stay at the call sites. Pure over `devices`
 * only (no analytics/recorder access).
 *
 * Membership: only ONLINE DPUs that are SHP2-connected sources contribute to
 * fleet PV / in / out / ac_in / battery-net (spares can't reach the home bus);
 * panelLoad is the sum of the SHP2's circuit watts. Each value is computed
 * exactly as the former inline loops did (same `?? 0` order, per-pack
 * out−in net, circuit-watt sum).
 */
/**
 * v1.3.0 (audit rank 3) — can we actually SEE the whole home battery pool right now?
 *
 * `aggregateFleetFlow` sums only DPUs that are BOTH cloud-online and SHP2-connected. A
 * home Core that is cloud-wedged — a documented recurring event on this fleet — silently
 * drops out of that sum while it keeps physically discharging. So any safety decision that
 * concludes "fleetBatteryNet is small, therefore the pool is not draining" is unsound
 * unless every home Core is reporting. We can PROVE discharge from a partial sum; we can
 * never DISPROVE it.
 *
 * The home-Core roster is the SHP2's own connected-source list when we have it. When we do
 * not (no SHP2, or a cloud-offline SHP2 whose sources[] lost `isConnected`) we fall back to
 * "every DPU that is not a designated bench spare" — which is exactly the population
 * `isShp2Connected`'s empty-set fallback already sums, and it still notices an OFFLINE home
 * Core, which the roster path would have missed entirely in that degraded state.
 *
 * An EMPTY roster means there are no home Cores in the device map at all — no pool exists,
 * so there is nothing we are failing to observe and `complete` is vacuously true. That is
 * NOT the "empty set looks fine" trap of [[project_audit_v069_v070]]: there, an empty
 * roster meant the observations were missing; here it means the subjects are.
 */
export function homeCoreCoverage(devices: Record<string, DeviceSnapshot>): {
  connected: number;
  reporting: number;
  complete: boolean;
} {
  const connected = shp2ConnectedDpuSns(devices);
  const roster: string[] = connected.size > 0
    ? [...connected]
    : Object.values(devices)
        .filter((d) => d.projection?.kind === 'dpu' && !SPARE_DPU_SNS.has(d.sn))
        .map((d) => d.sn);
  if (roster.length === 0) return { connected: 0, reporting: 0, complete: true };
  const online = new Set(onlineDpus(devices).map((d) => d.sn));
  const reporting = roster.filter((sn) => online.has(sn)).length;
  return { connected: roster.length, reporting, complete: reporting === roster.length };
}

/**
 * v1.8.0 (review F3) — reserve-alarm SHP2-blind fallback SoC.
 *
 * The reserve/SoC/runway alarm chain reads ONLY the SHP2 backup-pool % via
 * `shp2.projection.backupBatPercent`, which the SHP2 nulls when it goes
 * cloud-offline. The 30-day engine review found two blackouts (42.2h, 25.8h) in
 * which the pool physically crossed 50/40/30/20% while every reserve classifier
 * sat dark for 17.8–20.8h because that one field was null.
 *
 * Fallback: the mean SoC of the home Cores STILL REPORTING their own telemetry.
 * The SHP2 backup pool IS those same batteries, so their mean SoC is a faithful
 * proxy for the pool % — good enough to keep the audible ladder firing on the
 * right side of a real depletion (an approximate SoC that CAN alarm beats an
 * exact SoC that can't). Spares are excluded (not part of the pool); an offline
 * Core is excluded (its last-known SoC is stale). Returns null only when NO home
 * Core is reporting — in which case the reserve-blind warning + offline alerts
 * are the operator's signal, not a fabricated number.
 */
export function homeFleetMeanSoc(devices: Record<string, DeviceSnapshot>): number | null {
  const socs: number[] = [];
  for (const d of Object.values(devices)) {
    if (d.projection?.kind !== 'dpu') continue;
    if (SPARE_DPU_SNS.has(d.sn)) continue; // spares are not wired into the backup pool
    if (!d.online) continue;               // only Cores currently reporting fresh telemetry
    const s = d.projection.soc;
    if (s != null && Number.isFinite(s)) socs.push(s);
  }
  if (socs.length === 0) return null;
  return socs.reduce((a, b) => a + b, 0) / socs.length;
}

export function aggregateFleetFlow(devices: Record<string, DeviceSnapshot>): {
  fleetPv: number;
  fleetIn: number;
  fleetOut: number;
  acIn: number;
  fleetBatteryNet: number;
  panelLoad: number;
} {
  const dpus = onlineDpus(devices);
  const shp2 = findShp2(devices);
  const connected = shp2ConnectedDpuSns(devices);
  const gridDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));

  let fleetPv = 0, fleetIn = 0, fleetOut = 0, acIn = 0, fleetBatteryNet = 0;
  for (const d of gridDpus) {
    fleetPv += d.projection.pvTotalWatts ?? 0;
    fleetIn += d.projection.totalInWatts ?? 0;
    fleetOut += d.projection.totalOutWatts ?? 0;
    acIn += d.projection.acInWatts ?? 0;
    // v0.10.4 — battery net from PER-PACK flow, not DPU throughput.
    // v0.98.0 — `?? []` so a DPU projection without packs[] can't throw (aggregateFleetFlow
    // is now also on the grid-backstop path); a pack-less DPU simply contributes 0 net.
    for (const pk of d.projection.packs ?? []) fleetBatteryNet += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
  }

  let panelLoad = 0;
  // v0.98.0 — tolerate a partial SHP2 projection with no circuits[] (e.g. a /quota/all that
  // omits the circuit subtree). aggregateFleetFlow is now also reached from the grid-backstop
  // resolver, so it must not throw on an incomplete projection — a missing circuits array just
  // means panelLoad 0, never a crash.
  if (shp2) for (const c of shp2.projection.circuits ?? []) panelLoad += c.watts ?? 0;

  return { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad };
}
