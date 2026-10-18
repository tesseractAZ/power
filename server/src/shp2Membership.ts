/**
 * v0.9.74 — SHP2 membership filter for fleet-capacity aggregations.
 *
 * The reference setup: 5 EcoFlow Delta Pro Ultra cores on the EcoFlow Cloud
 * account, 3 of them wired into the home's SHP2 (Smart Home Panel) — Cores
 * 1, 2 and 5 since the 2026-08-20 swap. The others are bench spares — they can
 * charge on the bench / off a wall outlet and report telemetry, but they CAN'T
 * deliver energy into the home until they're wired into an SHP2.
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
/**
 * v1.129.0 — EVERY Smart Home Panel in the snapshot, not just the first one found.
 *
 * A second SHP2 is planned for this plant (it will carry the EV charger and the
 * garage bank). Until now every roster question resolved through a single
 * `find(kind === 'shp2')`, so a second panel would simply not exist: its DPUs
 * would be absent from `shp2ConnectedDpuSns`, `advanceOffPanelStreaks` would see
 * them as off-panel, and after three ticks their alerts would be demoted to
 * `annunciate: false` — a whole battery bank silently unmonitored, with no
 * warning, no alert and no log line to say so.
 *
 * `find` also picks by `/device/list` arrival order, so on a two-panel plant it
 * is not even stable which panel wins across a restart.
 */
export function allShp2s(
  devices: Record<string, DeviceSnapshot>,
): Array<DeviceSnapshot & { projection: Shp2Projection }> {
  return Object.values(devices).filter(
    (d) => d.projection?.kind === 'shp2',
  ) as Array<DeviceSnapshot & { projection: Shp2Projection }>;
}

export function shp2ConnectedDpuSns(devices: Record<string, DeviceSnapshot>): Set<string> {
  // v1.129.0 — UNION across every panel. This one line is the largest lever on
  // the second-SHP2 problem: it repairs isShp2Connected, isExpectedOfflineSpare,
  // isHomePoolDpu, homeCoreCoverage, homeFleetMeanSoc, aggregateFleetFlow's grid
  // DPUs, and — the one that matters most — alertMonitor's off-panel annunciation
  // demotion, so a second panel's DPUs keep alarming.
  const out = new Set<string>();
  for (const panel of allShp2s(devices)) {
    // v0.98.0 — `?? []` so a partial SHP2 projection with no sources[] subtree (e.g. a
    // /quota/all that returns the backup SoC but omits pd303_mc sources) can't throw. This
    // matches computeGridImportWatts's existing guard and matters now that aggregateFleetFlow
    // (which calls this) is also reached from the grid-backstop resolver.
    for (const src of panel.projection.sources ?? []) {
      if (src.isConnected && src.sn) out.add(src.sn);
    }
  }
  return out;
}

/**
 * v1.129.0 — the SHP2 census. Answers "how many smart panels does this plant
 * have?", which the rest of the app has never asked.
 *
 * Membership is deliberately WIDER than `projection.kind === 'shp2'`: a panel
 * that is in /device/list but whose /quota has not hydrated yet has no
 * projection at all, and that is precisely the window in which its Cores are
 * already accumulating off-panel streaks. The identity clause is byte-for-byte
 * the predicate `projectByProduct` uses (ecoflow/project.ts), so the census
 * cannot disagree with the projector about what an SHP2 is.
 *
 * `sns` is deduped and SORTED, and `primarySn` is its first element, so the
 * panel whose numbers the singleton paths report is PINNED rather than dependent
 * on device-map iteration order.
 */
/** v1.140.0 — how stale an SHP2 sample may be and still be a DEVICE READING. */
export const SHP2_READBACK_STALE_MS = 300_000;

/**
 * v1.140.0 — R3: is this SHP2 sample a live reading, or a frozen one?
 *
 * `setDeviceList` preserves `projection` VERBATIM across an offline transition,
 * by design, so every consumer that reads `shp2.projection` keeps seeing the
 * last successful sample for as long as the panel stays cloud-dark. For display
 * that is correct. For a CONTROL READBACK it is not: the night-charge actuator
 * compares `backupReserveSoc` by strict equality to decide whether a write took
 * effect, so over one dark night a frozen pre-write value never equals the
 * target — `retryApply`, then `applyFailed`, which is a critical push saying the
 * write NEVER TOOK EFFECT — and the scheduled revert then finds
 * `currentReservePct === priorReservePct` and stamps `revertVerified` for a
 * revert no device confirmed. Frozen at the raised target instead, the revert
 * escalates to `revertFailed`: a spoken bilingual CRITICAL broadcast, from a
 * sample that may be hours old.
 *
 * `gridState.ts` already applies exactly this gate to sibling fields on the same
 * projection, for exactly this stated reason. This is that precedent, named and
 * shared, so the two cannot drift.
 *
 * Callers should null the WHOLE readback group together — a half-gated read
 * leaves the coherence verdict judging frozen data. Every `decideActuation`
 * branch already treats null as "do nothing", which is the pause the actuator's
 * own comment promises.
 */
export function shp2ReadbackFresh(
  d: { online?: boolean; lastQuotaAtMs?: number; contentStaleSinceMs?: number | null } | undefined | null,
  nowMs: number,
  staleMs: number = SHP2_READBACK_STALE_MS,
): boolean {
  if (!d || d.online !== true) return false;
  // v1.142.0 — keyed on lastQuotaAtMs, NOT lastUpdated. `setDeviceOnline` bumps
  // lastUpdated on a bare /status flip that carries no telemetry and never
  // touches the projection, so an OFFLINE→ONLINE flip used to make this return
  // true against a sample nobody had refreshed — and the freeze scenario is
  // exactly one where no REST poll is coming, because refreshAll only fetches
  // devices the cloud list reports online.
  const lu = d.lastQuotaAtMs;
  if (typeof lu !== 'number' || !Number.isFinite(lu) || lu <= 0) return false;
  if (nowMs - lu > staleMs) return false;
  // v1.142.0 — and a payload the cloud is replaying is not a reading, however
  // recently it arrived (shp2Shadow.ts).
  return d.contentStaleSinceMs == null;
}

/**
 * v1.174.0 — PURE. What the night-charge PLANNER does with the panel reading it has
 * (log audit 2026-09-15, open 4: the 09-14 plan was sized + armed at 21:30 on a payload
 * latched stale 21:22-21:44; the actuator and force-charge ticks already gate on
 * shp2ReadbackFresh, the planner did not).
 *
 * A stale reading is NOT an incomplete basis: stale-shadow episodes run 2-6 min, 2-4
 * times a day, and the value is usually still right. So `use` is false only while the
 * caller can still wait (`allowStale` false); once it cannot, the stale reading is used
 * and `fresh:false` + `ageMs` travel with the plan. Never fail-closed on staleness alone
 * (2026-09-15: that would have killed a real 32.55 kWh night on correct data).
 *
 * `ageMs` is how old the CONTENT is: from `contentStaleSinceMs` (when the payload stopped
 * moving) when the cloud is replaying, else from the last quota.
 */
export function nightPlanPanelVerdict(
  d: { online?: boolean; lastQuotaAtMs?: number; contentStaleSinceMs?: number | null } | undefined | null,
  nowMs: number,
  allowStale: boolean,
): { use: boolean; fresh: boolean; ageMs: number | null; why: 'fresh' | 'offline' | 'replay' | 'no-quota' } {
  const fresh = shp2ReadbackFresh(d, nowMs);
  const since = d?.contentStaleSinceMs ?? d?.lastQuotaAtMs ?? null;
  const ageMs = typeof since === 'number' && Number.isFinite(since) && since > 0 ? Math.max(0, nowMs - since) : null;
  const why = fresh ? 'fresh'
    : d?.online !== true ? 'offline'
      : d?.contentStaleSinceMs != null ? 'replay'
        : 'no-quota';
  return { use: fresh || allowStale, fresh, ageMs, why };
}

export function shp2Panels(devices: Record<string, DeviceSnapshot>): {
  sns: string[];
  primarySn: string | undefined;
  projectedCount: number;
  identityCount: number;
} {
  const sns = new Set<string>();
  let projectedCount = 0;
  let identityCount = 0;
  for (const d of Object.values(devices)) {
    const projected = d.projection?.kind === 'shp2';
    const byName = (d.productName ?? '').toLowerCase().includes('smart home panel');
    if (!projected && !byName) continue;
    if (projected) projectedCount += 1;
    if (byName) identityCount += 1;
    if (d.sn) sns.add(d.sn);
  }
  const sorted = [...sns].sort();
  return { sns: sorted, primarySn: sorted[0], projectedCount, identityCount };
}

/**
 * True iff `sn` should be included in fleet aggregations.
 *
 * IMPORTANT — fallback semantics: when `connected` is empty (no SHP2
 * observed), this returns true for every SN. That's the safe-default
 * behavior for DPU-only setups; see module docstring.
 *
 * With the SHP2 present it returns true only for its connected sources (Cores
 * 1, 2 and 5 at 2026-10) and false for the bench Cores.
 */
export function isShp2Connected(sn: string, connected: Set<string>): boolean {
  if (connected.size === 0) return true;
  return connected.has(sn);
}

/**
 * v0.16.4 — Designated bench spares (Core 4 + Core 5 when written; the literal
 * is stale — see the v1.121.0 note below).
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
 * SAFETY FLOOR for the cloud-offline gate: a genuine home core — even one that
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
 * v1.121.0 — THE LITERAL ABOVE IS STALE, AND HAS BEEN SINCE 2026-08-20.
 *
 * That swap put Core 5 into SHP2 slot 3 and moved Core 3 to the bench, inverting
 * it: Core 5 is a live home-pool source (measured 2026-09-03 delivering ~1.87 kW
 * on slot 3) while the literal still calls it a spare, and the actual bench unit
 * (Core 3) is not listed at all.
 *
 * `isExpectedOfflineSpare`'s positive connected-source check hides this while the
 * SHP2 is reporting — Core 5 IS a connected source, so it is not muted. The hole
 * opens exactly when the SHP2 goes cloud-dark, a documented recurring state on
 * this plant: `connected` empties, the literal is consulted alone, and Core 5's
 * genuine offline alarm is muted as an "expected" bench state — during the window
 * where the alarm chain is already degraded.
 *
 * v1.117.0 built the right answer for `isHomePoolDpu` (live roster -> persisted
 * last-known roster -> literal) but the other consumers never got it. This is the
 * publisher that lets them share it without importing index.ts (same set/get
 * pattern as the actuator's posture flag).
 */
let publishedRoster: ReadonlySet<string> | null = null;

/** Feed the durable last-known home roster in (index.ts owns its persistence). */
export function setLastKnownHomeRoster(roster: ReadonlySet<string> | null | undefined): void {
  publishedRoster = roster && roster.size > 0 ? new Set(roster) : null;
}
export function resetLastKnownHomeRoster(): void { publishedRoster = null; }
/** v1.187.22 — the published last-known home roster (null until one is known): the roster the SoC
 *  ladders' fallback reads (index.ts passes the same set), so a reader that names the fallback figure
 *  — the reserve-alarm-blind alert — resolves the same Cores the ladder runs on. */
export function lastKnownHomeRoster(): ReadonlySet<string> | null { return rosterOf(); }

/** Explicit arg wins (tests, pure callers); otherwise the published roster. */
function rosterOf(explicit?: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (explicit && explicit.size > 0) return explicit;
  return publishedRoster && publishedRoster.size > 0 ? publishedRoster : null;
}

/**
 * v1.121.0 — "is this SN a bench spare?", resolved WITHOUT needing the device map.
 *
 * The literal is the safety floor (a DPU it does not name is never a spare), and
 * the durable last-known roster overrides it (a DPU the SHP2 most recently
 * reported as a home-pool source is not a spare, whatever the literal says).
 * Both conditions must agree before anything is treated as bench hardware, so
 * this can only ever REMOVE spare status — monotone in the fail-loud direction.
 */
export function isBenchSpareSn(sn: string, lastKnownRoster?: ReadonlySet<string> | null): boolean {
  if (!SPARE_DPU_SNS.has(sn)) return false;
  const roster = rosterOf(lastKnownRoster);
  if (roster && roster.has(sn)) return false;
  return true;
}

/** Every SN currently considered bench hardware (roster-aware). */
export function benchSpareSns(lastKnownRoster?: ReadonlySet<string> | null): string[] {
  return [...SPARE_DPU_SNS].filter((sn) => isBenchSpareSn(sn, lastKnownRoster));
}

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
export function isExpectedOfflineSpare(
  sn: string, connected: Set<string>, lastKnownRoster?: ReadonlySet<string> | null): boolean;
export function isExpectedOfflineSpare(
  sn: string, devices: Record<string, DeviceSnapshot>, lastKnownRoster?: ReadonlySet<string> | null): boolean;
export function isExpectedOfflineSpare(
  sn: string,
  connectedOrDevices: Set<string> | Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
): boolean {
  const connected =
    connectedOrDevices instanceof Set ? connectedOrDevices : shp2ConnectedDpuSns(connectedOrDevices);
  if (connected.has(sn)) return false;  // live source — re-armed, unchanged
  // v1.121.0 — when the SHP2 is dark the literal is no longer the last word.
  return isBenchSpareSn(sn, lastKnownRoster);
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
  // v1.129.0 — roster-aware. Every other consumer migrated to isBenchSpareSn in
  // v1.121.0; this one was left on the raw SPARE_DPU_SNS literal, which the
  // module's own comment records as STALE since the 2026-08-20 swap. A Core that
  // the literal still calls a spare but which is a live connected source would
  // have had its staleness check skipped here.
  if (isBenchSpareSn(source.sn)) return false;
  const dpu = devices[source.sn];
  return dpu != null && dpu.online === false;
}

/**
 * v1.188.1 — a Core's OWN meter is fresh: its telemetry content CHANGED (contentChangedAtMs,
 * snapshot.ts dpuContentWitness) within SHP2_READBACK_STALE_MS. The clock the grid resolver's
 * Core-import gate reads (gridState.ts coreContentFresh, v1.179.0/v1.181.0), and the recorder's
 * freshness gate for a Core (heldSamples.projectionRecordable): arrival is not enough, since a
 * REST 200 replaying a Core's cached body still bumps lastTelemetryAtMs. The
 * witness carries battery volts and amps, which move with every real reading, so a live Core's
 * clock moves within seconds (MQTT) or one poll (REST). Unknown (no change seen since a restart) =
 * not fresh.
 */
export function dpuContentFresh(
  d: { contentChangedAtMs?: number } | undefined | null,
  nowMs: number,
): boolean {
  const t = d?.contentChangedAtMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 && nowMs - t <= SHP2_READBACK_STALE_MS;
}

/**
 * v1.188.1 — the slot's Core is listed ONLINE with a projection, but its own meter is not fresh
 * (dpuContentFresh): every figure it shows is a frozen one. Reached when its quota fetch keeps
 * failing while /device/list still lists it (setDeviceError: "device still listed online,
 * projection frozen"), when the cloud replays its cached body (v1.181.0: its own connection lost,
 * the panel's still up), and for one list cycle after an OFFLINE→ONLINE /status flip. The Energy
 * flow card reads such a Core from the panel's meter of its slot, as it does an offline one
 * (dpuStale), and the backup timers do the same (poolNetUpperBound), as do the energy bridge and
 * the two power sensors (energyBridge.ts coreReports: no reading of its own). An offline Core is dpuStale,
 * not frozen; a Core with no projection has no figures to freeze.
 */
export function isSourceDpuFrozen(
  source: { isConnected: boolean; sn: string | null },
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
): boolean {
  if (!source.isConnected || !source.sn) return false;
  const dpu = devices[source.sn];
  return dpu != null && dpu.online === true && dpu.projection?.kind === 'dpu' && !dpuContentFresh(dpu, nowMs);
}

/**
 * v1.188.1 — a panel as the dashboard receives it (index.ts snapshotForClient). PURE: returns a
 * copy, never mutates the store's device. Each source slot carries `dpuStale` (v0.40.1, the Core is
 * offline) and `dpuFrozen` (the Core is listed online on a frozen meter), and the panel carries the
 * server's verdict on its own reading, `readbackFresh` (shp2ReadbackFresh). The card has no clock and
 * keys on these verdicts: `grid.panelFresh` judges only the house panel, so a second panel whose
 * quota keeps failing while it stays listed online read as live, and its frozen slot figures would
 * be drawn as the Cores delivering now.
 */
export function panelForClient(
  p: DeviceSnapshot & { projection: Shp2Projection },
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  verdicts?: BridgeVerdicts,
): DeviceSnapshot & { projection: Shp2Projection } {
  return {
    ...p,
    readbackFresh: shp2ReadbackFresh(p, nowMs),
    projection: {
      ...p.projection,
      sources: p.projection.sources.map((src) => ({
        ...src,
        dpuStale: isSourceDpuStale(src, devices),
        dpuFrozen: isSourceDpuFrozen(src, devices, nowMs),
        // v1.188.1 (review) — the bridge's verdicts, so the card counts each Core as the two power
        // sensors do: `ownReading` (its own meter: a Core the cloud lists offline whose MQTT data
        // still arrives included), and `pvMeasuredW` (the slot's PV where the bridge reads the
        // panel's PV field as measured; null otherwise).
        ...(verdicts && src.isConnected && src.sn ? {
          ownReading: verdicts.own.has(src.sn),
          pvMeasuredW: verdicts.measuredPvW.get(slotKey(p.sn, src.slot)) ?? null,
        } : {}),
      })),
    },
  };
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
  // v1.185.0 — THE HOUSE PANEL. The store stamps `housePanel` on exactly one panel
  // (resolveHousePanel, persisted in house-panel.json), and the flag travels with the
  // device into the analytics worker and the web client. A flagged panel with no
  // projection yet resolves to NOTHING rather than to the other panel: before this, a
  // second panel with a lower serial would have become the target of every singleton
  // path — the SoC ladder, the HA backup sensors and the night-charge reserve and
  // force-charge writes — the moment it was energised.
  // v1.129.0 — lowest SN wins rather than first-in-map (no panel flagged: no pin yet,
  // or two panels and the house panel not identified). Single pass — no allocation on a
  // hot path.
  // v1.185.0 (review) — and while the pinned panel is MISSING from the account
  // (`housePanelMissing` on every panel), nothing: a partial device list after a restart must never
  // hand the role — and the pending revert — to the other panel.
  let best: (DeviceSnapshot & { projection: Shp2Projection }) | undefined;
  let flagged: DeviceSnapshot | undefined;
  let missing = false;
  for (const d of Object.values(devices)) {
    if (d.housePanel === true) flagged = d;
    if (d.housePanelMissing != null) missing = true;
    if (d.projection?.kind !== 'shp2') continue;
    const cand = d as DeviceSnapshot & { projection: Shp2Projection };
    if (!best || (cand.sn ?? '') < (best.sn ?? '')) best = cand;
  }
  if (flagged) return flagged.projection?.kind === 'shp2' ? flagged as DeviceSnapshot & { projection: Shp2Projection } : undefined;
  if (missing) return undefined;
  return best;
}

/**
 * v1.185.0 — PURE. Which panel is the HOUSE panel: the one night charge writes to and whose
 * numbers the singleton surfaces (HA backup sensors, the dashboard pool, the forecast runway)
 * describe. `census` is the panels ON THE ACCOUNT (SnapshotStore.accountPanels: the identity
 * census less any panel absent from several consecutive device lists).
 *
 * - A pin, once set, never moves here — only an operator moves it (POST /api/house-panel, refused
 *   while a supervised write is outstanding). Its panel on the account: `pinned`. Not on the
 *   account: `missing` — nothing is retargeted, supervised writes pause, and an alert asks for a
 *   pin. (v1.185.0 review: an automatic re-pin from a restart's partial first list moved the role,
 *   and the pending revert, to the other panel for good.)
 * - No pin and exactly one panel, standing alone on consecutive lists (`singleStable`): pin it.
 *   Today's one-panel plant pins on its first boot, so a panel energised later never takes the
 *   role. Not yet stable: `none` (the legacy lowest-serial fallback, which is that one panel).
 * - No pin and two or more: `ambiguous` — supervised writes refused until an operator pins one.
 */
export function resolveHousePanel(
  census: readonly string[],
  pinnedSn: string | null,
  singleStable = true,
): { sn: string | null; pin: string | null; state: 'pinned' | 'missing' | 'ambiguous' | 'none' } {
  if (census.length === 0) return { sn: null, pin: pinnedSn, state: 'none' };
  if (pinnedSn != null) {
    return census.includes(pinnedSn)
      ? { sn: pinnedSn, pin: pinnedSn, state: 'pinned' }
      : { sn: null, pin: pinnedSn, state: 'missing' };
  }
  if (census.length === 1) return singleStable ? { sn: census[0], pin: census[0], state: 'pinned' } : { sn: null, pin: null, state: 'none' };
  return { sn: null, pin: null, state: 'ambiguous' };
}

/** v1.185.0 — the serial the house role belongs to: the flagged panel, else the MISSING pinned
 *  serial, else (no pin, or ambiguous) the lowest-serial projected panel findShp2 falls back to. */
export function houseSnOf(devices: Record<string, DeviceSnapshot>): string | undefined {
  let missing: string | undefined;
  for (const d of Object.values(devices)) {
    if (d.housePanel === true) return d.sn;
    if (d.housePanelMissing != null) missing = d.housePanelMissing;
  }
  return missing ?? findShp2(devices)?.sn;
}

/**
 * v1.188.1 (review) — each connected home Core ONCE, at the one panel listing that reads it. A Core
 * listed connected by two panels (one panel's source list is stale) is read at the listing on an
 * online panel whose reading is fresh (shp2ReadbackFresh), else on an online panel, else the first;
 * a tie goes to the house panel (houseSnOf), then the lower panel serial — never the device map's
 * order, which could keep the stale listing and drop the live one. Shared by the energy bridge (its
 * dark slots, the power sensors) and the backup timers' bound, so each counts a Core once, at the
 * same slot. `index` is the slot's position in the panel's sourceWatts.
 */
export function connectedSourceListings(
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
): Array<{ panel: DeviceSnapshot & { projection: Shp2Projection }; src: Shp2Projection['sources'][number]; index: number }> {
  type Listing = { panel: DeviceSnapshot & { projection: Shp2Projection }; src: Shp2Projection['sources'][number]; index: number };
  const house = houseSnOf(devices);
  const rank = (p: DeviceSnapshot): number => (p.online === true ? (shp2ReadbackFresh(p, nowMs) ? 2 : 1) : 0);
  const panels = [...allShp2s(devices)].sort((a, b) =>
    rank(b) - rank(a) || (b.sn === house ? 1 : 0) - (a.sn === house ? 1 : 0) || (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));
  const chosen = new Map<string, Listing>();
  for (const panel of panels) {
    (panel.projection.sources ?? []).forEach((src, index) => {
      if (!src.isConnected || !src.sn || chosen.has(src.sn)) return;
      chosen.set(src.sn, { panel, src, index });
    });
  }
  return [...chosen.values()];
}

/** v1.185.0 — every panel by identity (projected or not), sorted by serial. */
function identityPanels(devices: Record<string, DeviceSnapshot>): DeviceSnapshot[] {
  return Object.values(devices)
    .filter((d) => d.projection?.kind === 'shp2' || (d.productName ?? '').toLowerCase().includes('smart home panel'))
    .sort((a, b) => (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));
}

/**
 * v1.185.0 — every panel OTHER than the house panel, projected or not (a panel dark since a restart
 * has no projection but still has a pool to watch: its SoC ladder runs on its own Cores and its
 * reserve-blind alert stands). Sorted by serial.
 */
export function secondaryPanels(devices: Record<string, DeviceSnapshot>): DeviceSnapshot[] {
  const house = houseSnOf(devices);
  return identityPanels(devices).filter((p) => p.sn !== house);
}

/** v1.185.0 — a panel's Cores: its live connected sources, else the roster it last reported
 *  (DeviceSnapshot.lastRoster, persisted across restarts). */
export function panelRoster(panel: DeviceSnapshot): string[] {
  const live = panel.projection?.kind === 'shp2'
    ? ((panel.projection as Shp2Projection).sources ?? []).filter((x) => x.isConnected && x.sn).map((x) => x.sn as string)
    : [];
  return live.length > 0 ? live : [...(panel.lastRoster ?? [])];
}

/**
 * v1.185.0 — every PROJECTED panel other than the house panel, sorted by serial. These
 * carry their own SoC ladder, reserve alerts and runway (index.ts / alerts.ts); their
 * alert ids end in `-<serial>` so familyOf() rolls them up with the house panel's.
 */
export function secondaryShp2s(
  devices: Record<string, DeviceSnapshot>,
): Array<DeviceSnapshot & { projection: Shp2Projection }> {
  return secondaryPanels(devices).filter((p) => p.projection?.kind === 'shp2') as Array<DeviceSnapshot & { projection: Shp2Projection }>;
}

/**
 * v1.185.0 — ONE pool's SHP2-blind fallback SoC (homeFleetMeanSoc for one panel): the mean SoC of
 * this panel's Cores (panelRoster: live sources, else the persisted last roster) that are still
 * reporting. Null when no roster is known or none of its Cores is reporting.
 */
export function panelMeanSoc(
  devices: Record<string, DeviceSnapshot>,
  panel: DeviceSnapshot,
): number | null {
  const socs: number[] = [];
  for (const sn of panelRoster(panel)) {
    const d = devices[sn];
    if (!d || !d.online || d.projection?.kind !== 'dpu') continue;
    const s = d.projection.soc;
    if (s != null && Number.isFinite(s)) socs.push(s);
  }
  return socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;
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
export function homeCoreCoverage(
  devices: Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
  /** v1.188.1 (review) — with a clock, a Core counts as reporting only on a FRESH meter
   *  (dpuContentFresh): one listed online whose readings stopped changing (a quota that keeps
   *  failing, a cloud replaying its cached body, the first list cycle after an online flip) holds
   *  its last pack figures, which cannot disprove a drain. The at-floor guard passes it (gridState
   *  resolveGridBackstop), as the backup timers (poolNetUpperBound), the energy bridge and the
   *  power sensors already read such a Core as dark. Without one, the roster-only answer. */
  nowMs?: number,
): {
  connected: number;
  reporting: number;
  complete: boolean;
} {
  const connected = shp2ConnectedDpuSns(devices);
  // v1.121.0 — the SHP2-blind fallback used the stale literal, so it built the
  // roster {Core 1, Core 2, Core 3}: it counted BENCH Core 3 as a reporting home
  // Core and DROPPED live pool member Core 5. Coverage could therefore read
  // `complete` while a real pool member was unobserved, and gridState uses
  // exactly that flag to decide whether to withhold the at-floor grid backstop.
  // Roster SNs absent from `devices` are deliberately NOT filtered out: they
  // cannot be online, so they push `complete` false — the conservative direction.
  const remembered = rosterOf(lastKnownRoster);
  const roster: string[] = connected.size > 0
    ? [...connected]
    : remembered
      ? [...remembered]
      : Object.values(devices)
          .filter((d) => d.projection?.kind === 'dpu' && !SPARE_DPU_SNS.has(d.sn))
          .map((d) => d.sn);
  if (roster.length === 0) return { connected: 0, reporting: 0, complete: true };
  const online = new Set(onlineDpus(devices).filter((d) => nowMs == null || dpuContentFresh(d, nowMs)).map((d) => d.sn));
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
/**
 * v1.92.0 — "is this DPU wired into the home pool right now?", resolved from the
 * SHP2's OWN connected-source roster with the static allowlist as the
 * unknown-roster fallback. Use this for pool-membership questions (who counts
 * toward the pool, who gets audited); `isExpectedOfflineSpare` above keeps its
 * narrower "this SN's absence is expected" meaning for the offline-alert split.
 *
 * Fallback direction matters: when the SHP2 roster is unknown (empty — the panel
 * itself is cloud-dark) we fall back to the literal, which errs toward INCLUDING
 * a device. For a mean-SoC or audit decision that is the conservative side.
 */
export function isHomePoolDpu(
  sn: string,
  connectedOrDevices: Set<string> | Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
): boolean {
  const connected =
    connectedOrDevices instanceof Set ? connectedOrDevices : shp2ConnectedDpuSns(connectedOrDevices);
  if (connected.size > 0) return connected.has(sn);
  // v1.117.0 — LAST-KNOWN ROSTER before the static literal. The literal only
  // describes the bench at the moment it was written, and it has been wrong
  // since the 2026-08-20 swap moved Core 3 off-panel without being added to it.
  // On 2026-08-29 that staleness turned audible: during the first tick after a
  // deploy the SHP2 projection is not yet hydrated, so `connected` is empty,
  // the literal admitted the off-panel Core 3 (75%), and that phantom re-armed
  // the SoC ladder — replaying an already-announced 30% rung to the speakers on
  // BOTH deploys. The roster is durable STATE, so remember it rather than
  // re-deriving a guess from a hardcoded list every time the panel goes quiet.
  if (lastKnownRoster && lastKnownRoster.size > 0) return lastKnownRoster.has(sn);
  return !SPARE_DPU_SNS.has(sn);
}

/**
 * v1.154.0 — "does this DPU power nothing in the house right now?" for callers that
 * hold only the device map. isHomePoolDpu uses a remembered roster only when one is
 * PASSED, and isBenchSpareSn can only remove spare status from the SPARE_DPU_SNS
 * literal — which names Core 5 (wired) and not Core 3 (the actual bench unit). This
 * resolves live SHP2 roster → published last-known roster → literal, in that order.
 */
export function isOutsideHomePool(sn: string, devices: Record<string, DeviceSnapshot>): boolean {
  return !isHomePoolDpu(sn, devices, rosterOf());
}

export function homeFleetMeanSoc(
  devices: Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
): number | null {
  // v1.92.0 — membership comes from the SHP2's OWN connected-source roster, not
  // from the static SPARE_DPU_SNS literal (which only describes the bench at the
  // time it was written). On 2026-08-20 the plant was physically reconfigured:
  // Core 5 took SHP2 slot 3 while Core 3 moved to the bench, inverting the
  // literal. The allowlist-only filter then averaged a bench DPU and DROPPED a
  // live pool member, and because a bench unit charges independently the mean
  // acquired a hard floor of benchSoc/3 — with the bench unit at 63% the ladder
  // could not read below 21%, making every critical rung (15/10/8/4/2%)
  // unreachable during exactly the SHP2-blind window this fallback exists for.
  // Same roster resolution as homeCoreCoverage above: trust the panel, and fall
  // back to the literal only when the roster is unknown (empty).
  const roster = shp2ConnectedDpuSns(devices);
  const socs: number[] = [];
  for (const d of Object.values(devices)) {
    if (d.projection?.kind !== 'dpu') continue;
    if (!isHomePoolDpu(d.sn, roster, lastKnownRoster)) continue; // only DPUs actually wired into the backup pool
    if (!d.online) continue;               // only Cores currently reporting fresh telemetry
    const s = d.projection.soc;
    if (s != null && Number.isFinite(s)) socs.push(s);
  }
  if (socs.length === 0) return null;
  return socs.reduce((a, b) => a + b, 0) / socs.length;
}

/**
 * v1.185.0 — is the HOUSE pool's SHP2-blind fallback the one-panel case (homeFleetMeanSoc and its
 * roster tiers)? v1.187.22 — one decision, read by housePoolFallbackSoc and by its log-line
 * denominator housePoolFallbackCoverage, so the two can never resolve different rosters.
 */
function housePoolIsOnePanel(devices: Record<string, DeviceSnapshot>): boolean {
  // v1.185.0 (review) — a MISSING house pin is never the one-panel case: the panel left on the
  // account is another pool (a replacement, or the garage panel after the house panel dropped off).
  const missingPin = Object.values(devices).some((d) => d.housePanelMissing != null);
  return shp2Panels(devices).sns.length <= 1 && !missingPin;
}

/**
 * v1.185.0 — the HOUSE pool's SHP2-blind fallback SoC. With one panel this is homeFleetMeanSoc,
 * unchanged (its roster fallbacks cover a panel with no projection). With a second panel the
 * plant-wide mean would average the other pool's Cores into the house figure, so it is the house
 * panel's own Cores instead (panelMeanSoc).
 */
export function housePoolFallbackSoc(
  devices: Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
): number | null {
  if (housePoolIsOnePanel(devices)) return homeFleetMeanSoc(devices, lastKnownRoster);
  // v1.185.0 (review) — two panels: ONLY the house pool's own Cores, even while the house panel has
  // no projection (restart while dark: its persisted roster). Never the union — that would be the
  // other pool's Cores, holding the house ladder above rungs its own pool has crossed. No roster
  // known: null, and reserve-blind is the signal.
  const sn = houseSnOf(devices);
  const house = sn ? devices[sn] : undefined;
  return house ? panelMeanSoc(devices, house) : null;
}

/**
 * v1.187.22 — housePoolFallbackSoc's denominator, for the SoC ladders' boot-gate log line: how many
 * Cores of the roster that fallback averages over are reporting a SoC, of how many. The same roster
 * resolution: one panel — live sources, else the remembered roster, else every non-spare Core; several
 * panels — the house panel's own roster (none known: 0 of 0).
 */
export function housePoolFallbackCoverage(
  devices: Record<string, DeviceSnapshot>,
  lastKnownRoster?: ReadonlySet<string> | null,
): { reporting: number; roster: number } {
  let roster: string[];
  if (housePoolIsOnePanel(devices)) {
    const live = shp2ConnectedDpuSns(devices);
    roster = live.size > 0
      ? [...live]
      : lastKnownRoster && lastKnownRoster.size > 0
        ? [...lastKnownRoster]
        : Object.values(devices).filter((d) => d.projection?.kind === 'dpu' && !SPARE_DPU_SNS.has(d.sn)).map((d) => d.sn);
  } else {
    const sn = houseSnOf(devices);
    const house = sn ? devices[sn] : undefined;
    roster = house ? panelRoster(house) : [];
  }
  const reporting = roster.filter((sn) => {
    const d = devices[sn];
    const s = d?.online && d.projection?.kind === 'dpu' ? d.projection.soc : null;
    return s != null && Number.isFinite(s);
  }).length;
  return { reporting, roster: roster.length };
}

export function aggregateFleetFlow(devices: Record<string, DeviceSnapshot>): {
  fleetPv: number;
  fleetIn: number;
  fleetOut: number;
  acIn: number;
  fleetBatteryNet: number;
  /** v1.186.2 — the same sum preferring each pack's `liveFlow` (DISPLAY: sensor + card). */
  fleetBatteryNetDisplay: number;
  panelLoad: number;
} {
  const dpus = onlineDpus(devices);
  const connected = shp2ConnectedDpuSns(devices);
  const gridDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));

  let fleetPv = 0, fleetIn = 0, fleetOut = 0, acIn = 0, fleetBatteryNet = 0, fleetBatteryNetDisplay = 0;
  for (const d of gridDpus) {
    fleetPv += d.projection.pvTotalWatts ?? 0;
    fleetIn += d.projection.totalInWatts ?? 0;
    fleetOut += d.projection.totalOutWatts ?? 0;
    acIn += d.projection.acInWatts ?? 0;
    // v0.10.4 — battery net from PER-PACK flow, not DPU throughput.
    // v0.98.0 — `?? []` so a DPU projection without packs[] can't throw (aggregateFleetFlow
    // is now also on the grid-backstop path); a pack-less DPU simply contributes 0 net.
    // v1.186.2 — two sums. `fleetBatteryNet` stays the RAW evidence the at-floor discharge guard
    // (gridState.ts poolDischargingObserved) reads, deliberately fail-loud. The display sum
    // prefers the MQTT stream's fresh value over the REST poll's last-non-zero replay.
    for (const pk of d.projection.packs ?? []) {
      fleetBatteryNet += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
      const f = pk.liveFlow ?? pk;
      fleetBatteryNetDisplay += (f.outputWatts ?? 0) - (f.inputWatts ?? 0);
    }
  }

  let panelLoad = 0;
  // v0.98.0 — tolerate a partial SHP2 projection with no circuits[] (e.g. a /quota/all that
  // omits the circuit subtree). aggregateFleetFlow is now also reached from the grid-backstop
  // resolver, so it must not throw on an incomplete projection — a missing circuits array just
  // means panelLoad 0, never a crash.
  // v1.185.0 — EVERY panel's circuits. The flows above already sum the Cores of every panel
  // (v1.129.0's union roster); a load from one panel beside them paired a whole-plant supply
  // with half a house. One panel: identical.
  for (const p of allShp2s(devices)) for (const c of p.projection.circuits ?? []) panelLoad += c.watts ?? 0;

  return { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, fleetBatteryNetDisplay, panelLoad };
}

/** v1.188.1 — the backup timers' direction deadband (W), v0.15.12's ±50 W. */
export const BACKUP_TIMER_DEADBAND_W = 50;

/**
 * v1.188.1 (review) — what a Core draws from its own packs without it crossing its panel slot: its
 * standby and conversion losses. The energy bridge measured them at 4.7-6.1 kWh/day for the three
 * home Cores (energyBridge.ts, the inferred PV basis's near-constant shortfall on 8 recorded days:
 * 65-85 W per Core), rounded up, since poolNetUpperBound must bound the pack net from above.
 */
export const SLOT_UNMETERED_DRAW_W = 100;

/**
 * v1.188.1 (review) — the energy bridge's verdicts (energyBridge.ts slotVerdicts, from the same
 * computation the two power sensors publish), handed to the surfaces that must agree with Fleet PV
 * and Battery Net: the backup timers' bound (poolNetUpperBound) and the dashboard card
 * (panelForClient). Optional: without it each keeps its own rule (a Core listed online on a fresh
 * meter is on its own meter; no slot's PV is known).
 */
export interface BridgeVerdicts {
  /** Connected home Cores the power sensors count at their own reading (energyBridge coreReports;
   *  a marked Core only once it hands back). */
  own: ReadonlySet<string>;
  /** A dark slot's panel PV figure (W) where the bridge reads it as measured (its field trusted and
   *  the sun up: the 'measured' basis), keyed slotKey(panelSn, slot). */
  measuredPvW: ReadonlyMap<string, number>;
}

/** The key of one panel's source slot (1-based, as the panel numbers its sources). */
export const slotKey = (panelSn: string, slot: number): string => `${panelSn}#${slot}`;

/**
 * v1.188.1 — an UPPER BOUND on the home pool's battery net (W, > 0 = discharging), for the backup
 * timers' direction gate (backupTimerGate); +Infinity when nothing bounds it.
 *
 * With every connected home Core reporting on a fresh meter (homeCoreCoverage complete, none
 * frozen: isSourceDpuFrozen) it is the exact display sum the gate has always read
 * (aggregateFleetFlow fleetBatteryNetDisplay), basis 'cores'. Otherwise that sum does not measure
 * the pool: with every Core dark it is 0 W, and the gate read that as "not discharging" — live
 * 2026-10-16 20:04 MST every Core was cloud-offline and the pool drained ~3.4 kW through the panel
 * while /api/ha-state published 38 min to full and the console showed "▲ CHG 38m" beside a 0 W
 * battery net. Each connected slot then contributes:
 *   · its Core's own pack net, when that Core reports on a fresh meter;
 *   · else, while that panel's reading is fresh (shp2ReadbackFresh), the negated slot meter
 *     (−sourceWatts: the AC the Core delivers into the panel) plus SLOT_UNMETERED_DRAW_W. The slot
 *     sees neither the Core's PV, which only adds to its charge, nor its standby draw and conversion
 *     losses, which come out of its packs: pack net = −slot − PV + draw ≤ −slot + draw. So this
 *     bounds the pack net from ABOVE: a slot proves a charge only while it takes in more AC than the
 *     Core's own draw, and a slot delivering does not prove a discharge (by day that can be the
 *     Core's PV passing through while its packs charge). At the reserve hold, where the slots read
 *     about 0 W while the packs still supply the Cores' standby, the bound reads a discharge, never
 *     a charge;
 *   · else +Infinity, basis 'unmeasured'.
 * As in gridState's at-floor guard (v1.3.0), a partial roster can prove one direction and never
 * disprove the other, and the unknown resolves toward discharging.
 *
 * v1.188.1 (review) — with the energy bridge's `verdicts` (both state publishers and the console
 * pass them), a Core is on its own meter exactly when the two power sensors count it at its own
 * reading (a Core the cloud lists offline whose MQTT data still arrives is; a marked Core not yet
 * handed back is not), and a dark slot whose panel PV field the bridge reads as measured takes that
 * PV out (−slot − PV + draw): by day the bound otherwise stayed positive while the published Battery
 * Net read a charge, so the time to empty was published and the time to full withheld. Each Core is
 * read once, at the listing the bridge meters it at (connectedSourceListings).
 */
export function poolNetUpperBound(
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  verdicts?: BridgeVerdicts,
): { watts: number; basis: 'cores' | 'panel' | 'unmeasured' } {
  const connected = shp2ConnectedDpuSns(devices);
  const frozen = [...connected].some((sn) => isSourceDpuFrozen({ isConnected: true, sn }, devices, nowMs));
  const listings = connectedSourceListings(devices, nowMs);
  // v1.188.1 (review) — with the bridge's verdicts, a Core is on its own meter exactly when the two
  // power sensors count it at its own reading (a Core the cloud lists offline whose MQTT data still
  // arrives included; a marked Core that has not handed back excluded), so the timers and Battery
  // Net never take one Core two ways.
  const ownReading = (sn: string): boolean => {
    const d = devices[sn];
    if (d?.projection?.kind !== 'dpu') return false;
    return verdicts ? verdicts.own.has(sn) : d.online === true && dpuContentFresh(d, nowMs);
  };
  if (homeCoreCoverage(devices).complete && !frozen && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) {
    return { watts: aggregateFleetFlow(devices).fleetBatteryNetDisplay, basis: 'cores' };
  }
  let watts = 0;
  // v1.188.1 (review) — each connected Core once, at the listing the energy bridge reads it at
  // (connectedSourceListings), never by the device map's order.
  for (const { panel: p, src: s, index: i } of listings) {
    const d = devices[s.sn as string];
    if (ownReading(s.sn as string) && d?.projection?.kind === 'dpu') {
      for (const pk of d.projection.packs ?? []) { const f = pk.liveFlow ?? pk; watts += (f.outputWatts ?? 0) - (f.inputWatts ?? 0); }
      continue;
    }
    const w = p.projection.sourceWatts?.[i];
    // v1.188.1 (review) — the slot's PV, where the energy bridge reads the panel's PV field as
    // measured (trusted, the sun up): Battery Net publishes −slot − PV for that slot, so the bound
    // takes the same PV out (pack net ≤ −slot − PV + draw). The field's check catches a field that
    // reads LOW only: a field reading high would show the time to full early, beside a Battery Net
    // reading the same charge. Without a trusted field the bound has no PV term (delivery through
    // the slot can be PV passing through, so it never proves a discharge by itself).
    const pv = verdicts?.measuredPvW.get(slotKey(p.sn, s.slot)) ?? 0;
    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity;
  }
  // No slot to read: the roster is a remembered or fallback one (no connection table).
  if (listings.length === 0) watts = Infinity;
  return { watts, basis: Number.isFinite(watts) ? 'panel' : 'unmeasured' };
}

/**
 * v1.188.1 — which of the panel's two backup timers applies. The SHP2 reports both regardless of
 * direction (v0.15.12: "1.7 h to full" while discharging), so each is published only while the
 * pool is not proven to run the other way: the charge timer while the pool's net is at most
 * +50 W, the discharge timer while it is at least −50 W — on poolNetUpperBound, which is the
 * Cores' exact sum while every home Core reports and a bound through the panel otherwise. Shared
 * by /api/ha-state (backup_charge_minutes / backup_discharge_minutes) and the console's RUN line.
 */
export function backupTimerGate(
  devices: Record<string, DeviceSnapshot>,
  nowMs: number,
  verdicts?: BridgeVerdicts,
): { charge: boolean; discharge: boolean; basis: 'cores' | 'panel' | 'unmeasured' } {
  const { watts, basis } = poolNetUpperBound(devices, nowMs, verdicts);
  return { charge: watts <= BACKUP_TIMER_DEADBAND_W, discharge: watts >= -BACKUP_TIMER_DEADBAND_W, basis };
}
