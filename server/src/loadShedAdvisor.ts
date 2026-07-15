/**
 * loadShedAdvisor.ts — the intelligent load-shedding ADVISOR (Phase 1).
 *
 * Per the design decision, this is advisory-only: it never actuates. It reads
 * the runway projection + live HA device state + SHP2 circuit watts, decomposes
 * the load, and emits a recommendation — "if you shed the pool pump + EVSE,
 * runway extends from ~3.5 h to up to ~8 h". The operator's own HA automations
 * (or a future Phase 2) consume the recommendation and decide whether to act.
 *
 * The decision logic reuses classifyRunway() from runwayAlarm.ts verbatim, so
 * the shed bands line up exactly with the audible runway alarm.
 *
 * All core functions here are PURE (no I/O) so they can be unit-tested without a
 * live HA or analytics worker; the thin createLoadShedAdvisor() wrapper injects
 * the accessors, mirroring how runwayAlarm/batterySocAlarm take callbacks.
 */
import { classifyRunway, type GridContext } from './runwayAlarm.js';
import { RUNWAY_DISCHARGE_EFFICIENCY } from './analytics.js';
import type { AlarmPriority } from './alertPriority.js';
import type { ShedCandidate } from './loadShedRegistry.js';
import type { CachedEntity } from './haStateCache.js';

/** The runway fields the advisor needs — a structural subset of RunwayProjection. */
export interface RunwayLike {
  generatedAt: number;
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  unavailable: string | null;
  backupRemainingKwh: number | null;
  backupReserveKwh: number | null;
}

export interface LoadCompositionEntry {
  entityId: string;
  label: string;
  priority: number;
  /** true=on, false=off, null=HA state not readable. */
  currentlyOn: boolean | null;
  /** v0.15.18 — false when the entity is missing from HA or reports
   *  unavailable/unknown (e.g. a dead device still on the allowlist), so the
   *  operator can see a phantom candidate instead of silently counting it. */
  available: boolean;
  measuredWatts: number | null;
  source: 'shp2_circuit' | 'ha_power_sensor' | 'estimated' | 'unknown';
  flaggedKeyword: string | null;
}

export interface ShedRecommendation {
  entityId: string;
  label: string;
  priority: number;
  wattsSaved: number;
}

export interface LoadShedAdvisory {
  generatedAt: number;
  band: AlarmPriority | null;
  actionable: boolean;
  thresholdHours: number;
  restoreMarginHours: number;
  current: { hoursToReserve: number | null; hoursToEmpty: number | null };
  projectedAfterShed: { hoursToReserve: number | null; hoursToEmpty: number | null };
  /** The counterfactual is an UPPER BOUND (assumes shed loads draw across the whole horizon). */
  isUpperBound: boolean;
  totalRecommendedWatts: number;
  recommended: ShedRecommendation[];
  composition: LoadCompositionEntry[];
  note: string;
}

const ON_STATES = new Set(['on', 'open', 'playing', 'heat', 'cool', 'heat_cool', 'auto', 'home', 'true', 'active', 'charging']);
function isOnState(s: string): boolean {
  return ON_STATES.has(String(s).toLowerCase());
}

/**
 * Counterfactual runway if `shedWatts` of load were removed. UPPER BOUND: it
 * assumes the shed load was drawing for the entire window, which overstates the
 * benefit for intermittent loads (EVSE, pool pump) — so the result is labeled
 * isUpperBound and phrased "up to". Backs the average net-discharge rate out of
 * the projection's own (remaining − reserve)/hoursToReserve, subtracts the shed
 * power, and re-derives the time. Returns null (= "no depletion in horizon")
 * when shedding exceeds the net draw.
 */
export function computeRunwayWithShedOffset(
  runway: Pick<RunwayLike, 'backupRemainingKwh' | 'backupReserveKwh' | 'hoursToReserve' | 'hoursToEmpty'>,
  shedWatts: number,
): { hoursToReserve: number | null; hoursToEmpty: number | null } {
  const shedKw = Math.max(0, shedWatts) / 1000;
  const scale = (energyKwh: number | null, hours: number | null): number | null => {
    if (hours == null) return null; // already not depleting within horizon
    if (energyKwh == null || energyKwh <= 0 || hours <= 0) return hours;
    const netKw = energyKwh / hours;
    // v1.26.0 — `hours` is now the η-corrected POOL-drain countdown, so netKw is
    // the gross pool-drain rate (delivered load / η). Shedding shedKw of DELIVERED
    // load reduces the pool drain by shedKw/η, not shedKw — divide onto the same
    // pool basis so the two terms are consistent (else the shed benefit is
    // under-counted by ~1/η, understating the extended runway).
    const newNetKw = netKw - shedKw / RUNWAY_DISCHARGE_EFFICIENCY;
    if (newNetKw <= 0.001) return null; // shedding ≥ net draw → no depletion
    return Math.round((energyKwh / newNetKw) * 10) / 10;
  };
  const remain = runway.backupRemainingKwh;
  const reserve = runway.backupReserveKwh;
  const toReserveEnergy = remain != null && reserve != null ? remain - reserve : null;
  return {
    hoursToReserve: scale(toReserveEnergy, runway.hoursToReserve),
    hoursToEmpty: scale(remain, runway.hoursToEmpty),
  };
}

/**
 * Decompose the allowlist into a live composition, choosing the best watt source
 * per entity: SHP2 circuit (authoritative) → HA power sensor → operator estimate.
 */
export function buildLoadComposition(
  candidates: ShedCandidate[],
  haEntity: (id: string) => CachedEntity | null,
  shp2CircuitWatts: (ch: number) => number | null,
): LoadCompositionEntry[] {
  return candidates.map((c) => {
    const ha = haEntity(c.entityId);
    // v0.15.18 — an entity missing from HA or stuck unavailable/unknown is a
    // phantom candidate (observed: a dead patio light on the priority-1 list).
    // It can never be shed (currentlyOn stays false/null below), but flagging
    // it explicitly surfaces the rot to the operator.
    const available = ha != null && ha.state !== 'unavailable' && ha.state !== 'unknown';
    const currentlyOn = ha && available ? isOnState(ha.state) : null;
    let measuredWatts: number | null = null;
    let source: LoadCompositionEntry['source'] = 'unknown';
    if (c.shp2Ch != null) {
      const w = shp2CircuitWatts(c.shp2Ch);
      if (w != null && Number.isFinite(w)) {
        measuredWatts = Math.round(w);
        source = 'shp2_circuit';
      }
    }
    if (measuredWatts == null && ha?.watts != null) {
      measuredWatts = Math.round(ha.watts);
      source = 'ha_power_sensor';
    }
    if (measuredWatts == null && c.estimatedWatts > 0) {
      measuredWatts = c.estimatedWatts;
      source = 'estimated';
    }
    return {
      entityId: c.entityId,
      label: c.label,
      priority: c.priority,
      currentlyOn,
      available,
      measuredWatts,
      source,
      flaggedKeyword: c.flaggedKeyword,
    };
  });
}

/**
 * Produce the recommendation. Only recommends when the runway is in an actionable
 * band (medium/high/critical) AND below the configured threshold. Walks the
 * composition shed-first, accumulating only loads that are currently ON with a
 * positive watt figure, until the (upper-bound) counterfactual runway clears the
 * threshold + restore margin or the list is exhausted.
 */
// v0.92.0 — minimum runway-to-reserve extension (hours) a recommended shed must
// buy before it is marked actionable. Below this the shed is cosmetic (its watts
// are negligible against the current draw) and a "shed now" prompt would mislead.
const MIN_SHED_BENEFIT_HOURS = 0.25;

export function computeAdvisory(opts: {
  now: number;
  runway: RunwayLike;
  composition: LoadCompositionEntry[];
  thresholdHours: number;
  restoreMarginHours: number;
  /** v0.92.0 — grid-backstop context. When the grid is carrying the load at the
   *  floor, classifyRunway returns null (no depletion emergency), so the advisor
   *  must NOT recommend shedding — mirrors runwayAlarm.update's grid arg. Without
   *  it the advisor was grid-BLIND and reported critical/actionable while the
   *  audible alarm was (correctly) silent, contradicting the alarm the operator
   *  hears. */
  grid?: GridContext;
}): LoadShedAdvisory {
  const { now, runway, composition, thresholdHours, restoreMarginHours, grid } = opts;
  const band = classifyRunway(runway, grid);
  const current = { hoursToReserve: runway.hoursToReserve, hoursToEmpty: runway.hoursToEmpty };
  const targetHours = thresholdHours + restoreMarginHours;

  const inBand = band === 'medium' || band === 'high' || band === 'critical';
  const belowThreshold =
    (runway.hoursToReserve != null && runway.hoursToReserve <= thresholdHours) ||
    (runway.hoursToEmpty != null && runway.hoursToEmpty <= thresholdHours);

  const recommended: ShedRecommendation[] = [];
  let totalRecommendedWatts = 0;
  let projectedAfterShed = current;

  if (inBand && belowThreshold) {
    for (const c of composition) {
      if (c.currentlyOn !== true) continue; // only shed what we know is on
      const w = c.measuredWatts ?? 0;
      if (w <= 0) continue;
      recommended.push({ entityId: c.entityId, label: c.label, priority: c.priority, wattsSaved: w });
      totalRecommendedWatts += w;
      projectedAfterShed = computeRunwayWithShedOffset(runway, totalRecommendedWatts);
      const clears = projectedAfterShed.hoursToReserve == null || projectedAfterShed.hoursToReserve >= targetHours;
      if (clears) break;
    }
  }

  // v0.92.0 — a shed is only actionable if it MEANINGFULLY extends the runway.
  // Previously actionable=true whenever any allowlisted load was on, even when the
  // recommended shed bought ~0 extra hours (e.g. 70 W off a ~6 kW draw left
  // hoursToReserve unchanged) — a misleading "shed now" with no benefit. Require a
  // measurable improvement (or the shed to remove the depletion entirely).
  const materiallyHelps =
    projectedAfterShed.hoursToReserve == null || // shed clears the depletion in-horizon
    (runway.hoursToReserve != null &&
      projectedAfterShed.hoursToReserve >= runway.hoursToReserve + MIN_SHED_BENEFIT_HOURS);
  const actionable = inBand && belowThreshold && recommended.length > 0 && materiallyHelps;
  const note = buildNote(band, current, projectedAfterShed, recommended, composition, actionable);

  return {
    generatedAt: now,
    band,
    actionable,
    thresholdHours,
    restoreMarginHours,
    current,
    projectedAfterShed,
    isUpperBound: true,
    totalRecommendedWatts,
    recommended,
    composition,
    note,
  };
}

function fmtH(h: number | null): string {
  return h == null ? 'no depletion in horizon' : `${h.toFixed(1)} h`;
}

function buildNote(
  band: AlarmPriority | null,
  current: { hoursToReserve: number | null; hoursToEmpty: number | null },
  projected: { hoursToReserve: number | null; hoursToEmpty: number | null },
  recommended: ShedRecommendation[],
  composition: LoadCompositionEntry[],
  actionable: boolean,
): string {
  if (composition.length === 0) {
    return 'No sheddable loads configured (LOAD_SHEDDING_SHED_ENTITIES is empty) — advisory inactive.';
  }
  if (band == null) {
    // v0.92.0 — includes the grid-backstopping case: classifyRunway returns null
    // while the grid carries the load at the floor, so no shed is warranted.
    return 'Runway healthy (or grid backstopping) — no shed recommended.';
  }
  if (recommended.length === 0) {
    return `Runway in ${band} band but nothing actionable (no allowlisted load is currently on with a measurable draw).`;
  }
  if (!actionable) {
    const saved = recommended.reduce((s, r) => s + r.wattsSaved, 0);
    return (
      `Runway ${band}: reserve in ${fmtH(current.hoursToReserve)}. The only available shed ` +
      `(~${saved} W) would not meaningfully extend it — no actionable shed.`
    );
  }
  const names = recommended.map((r) => r.label).join(' + ');
  const saved = recommended.reduce((s, r) => s + r.wattsSaved, 0);
  return (
    `Runway ${band}: reserve in ${fmtH(current.hoursToReserve)}. Shedding ${names} ` +
    `(~${saved} W) would extend reserve to up to ${fmtH(projected.hoursToReserve)}.`
  );
}

// --- Stateful holder (latest advisory) for the API + MQTT export path ---------

let latest: LoadShedAdvisory | null = null;
export function getLatestAdvisory(): LoadShedAdvisory | null {
  return latest;
}
export function setLatestAdvisory(a: LoadShedAdvisory): void {
  latest = a;
}

/**
 * Flat fields published into the MQTT state payload so the operator's HA
 * automations can gate on the recommendation (the advisory actuation model).
 * NOTE: current runway-to-reserve/empty are already published by buildState
 * (runway_to_reserve_hours / runway_to_empty_hours), so only the NEW advisory
 * signals — including the counterfactual "if shed" runway — are added here.
 */
export function advisoryStateFields(a: LoadShedAdvisory | null): {
  load_shed_recommended: boolean;
  load_shed_recommended_count: number;
  load_shed_recommended_watts: number;
  runway_to_reserve_if_shed_hours: number | null;
} {
  return {
    load_shed_recommended: !!a && a.recommended.length > 0,
    load_shed_recommended_count: a ? a.recommended.length : 0,
    load_shed_recommended_watts: a ? a.totalRecommendedWatts : 0,
    runway_to_reserve_if_shed_hours: a ? a.projectedAfterShed.hoursToReserve : null,
  };
}

export interface LoadShedAdvisor {
  update(runway: RunwayLike, grid?: GridContext): LoadShedAdvisory;
  getStatus(): LoadShedAdvisory | null;
}

export function createLoadShedAdvisor(deps: {
  getCandidates: () => ShedCandidate[];
  haEntity: (id: string) => CachedEntity | null;
  shp2CircuitWatts: (ch: number) => number | null;
  thresholdHours: () => number;
  restoreMarginHours: () => number;
  now?: () => number;
}): LoadShedAdvisor {
  const now = deps.now ?? (() => Date.now());
  return {
    update(runway: RunwayLike, grid?: GridContext): LoadShedAdvisory {
      const composition = buildLoadComposition(deps.getCandidates(), deps.haEntity, deps.shp2CircuitWatts);
      const a = computeAdvisory({
        now: now(),
        runway,
        composition,
        thresholdHours: deps.thresholdHours(),
        restoreMarginHours: deps.restoreMarginHours(),
        grid,
      });
      setLatestAdvisory(a);
      return a;
    },
    getStatus: () => getLatestAdvisory(),
  };
}
