/**
 * v1.178.0 — a published value is null ("unknown" in Home Assistant) until the data behind it
 * exists. Shared by both state publishers: MQTT (mqttDiscovery.ts buildState) and the REST
 * twin (/api/ha-state in index.ts).
 *
 * The first MQTT state publish runs on broker connect, ~0.8 s BEFORE the first device poll
 * hydrates any projection, before the alarm monitor's first evaluation, before the first
 * speaker probe, and against an analytics worker whose device view is still empty. Every
 * figure computed from missing data came out 0 and was published as a measurement; the next
 * publish then waited ~75 s behind a cold report's timeout and retry. Swept across Home
 * Assistant history for 2026-09-22's four restarts: 16 sensors went X → 0 → X at EVERY
 * restart (fleet PV, battery net, panel load, five alarm counts, the speaker count, CO2 7 d,
 * tariff today/7 d, curtailment 7 d, array peak, forecast PV). Measurement sensors took a
 * false minimum of 0 into every restart hour, and the Energy dashboard's solar/battery rate
 * notched to 0. `pv_curtailment_kwh_today` is total_increasing: its 5.44 → 0 → 5.44 kWh boot
 * dip read as a meter reset and the day's curtailment was counted again (8 times since 09-01).
 *
 * Each group names the fields that share one readiness condition; a field is nulled only
 * while its own data is missing, so nothing is held back that is real. v1.186.0 — alarm counts
 * publish once the monitor's set is complete (a hydrated store, every alert feed delivered),
 * or at its bound (ALERT_COUNTS_READY_MAX_MS) when a feed never delivers.
 *
 * v1.187.10 — "the data behind it exists" also means the data is a READING, not a replay. While a
 * Smart Home Panel 2 fails shp2ReadbackFresh (cloud-offline, no quota, REST or MQTT, for
 * SHP2_READBACK_STALE_MS, or replaying a cloud shadow) its projection is frozen, and the server
 * already treats it so: shp2_grid_connected reads unknown and the dashboard shows the panel's
 * figures as stale. The panel's live figures (load, grid power, grid status, backup pool and the
 * per-circuit watts) kept publishing as values: 2026-10-02 00:05–00:14 MST Panel Load sat at
 * 1611 W while the Cores' battery net rose to ~4.1 kW, and the first fresh reading was 3626 W.
 * MQTT expire_after cannot catch it: each 30 s republish resets the timer. They now publish null
 * (`panel`, `panelLive`). And a forecast or runway the analytics worker built while a home Core's
 * first reading was still pending (homeBasisPending) is withheld: at boot they published
 * Projected Low SoC 0 % and a finite runway computed with that Core's PV missing.
 *
 * v1.187.18 — likewise the degradation report built while the device map was still filling
 * (FleetDegradation.basisPending): 2026-10-11 12:23 it counted one bench Core's 4 packs of 24, and
 * HA read degradation_packs_total 4, projecting 0 and no soonest EOL for 30 min.
 */

import type { DeviceSnapshot } from './snapshot.js';
import { shp2ConnectedDpuSns, isShp2Connected, shp2Panels, findShp2, allShp2s, shp2ReadbackFresh } from './shp2Membership.js';

export interface PublishReadiness {
  /** An online home Core — one the panel lists as a source, or any Core on a DPU-only
   *  install — has a projection: fleet flows are sums over real readings. The same
   *  membership aggregateFleetFlow sums over, so a bench spare alone does not count. A panel
   *  listed but not yet projected (the boot race, or a panel cloud-offline at a restart) is
   *  not a DPU-only install: membership is unknown, so the flows wait for it (the same line
   *  the tariff report's basisComplete draws). */
  flow: boolean;
  /** v1.188.1 — Fleet PV and Battery Net: the `flow` condition, with a home Core that is dark
   *  (cloud-offline, its panel slot connected) counted through the energy bridge, which meters it
   *  at the panel (energyBridge.bridgeFleetFlow). Ready when membership is known, something is
   *  summed (an online home Core, or a bridged slot), and NO dark slot is unbridgeable right now
   *  (a panel reading that is not fresh, or daylight without a trusted PV field). Before v1.188.1
   *  both were withheld while every home Core was dark: Home Assistant's Now view read 0 W of
   *  power usage for two days (2026-10-15/16) while the house drew ~3.4 kW from those Cores. */
  flowBridged: boolean;
  /** The panel has a projection with at least one reported channel. v1.187.10 — and EVERY
   *  projected panel's reading is fresh (shp2ReadbackFresh): the load sums every panel's
   *  channels, and a sum that is half live, half frozen is neither (the dashboard's rule). */
  panel: boolean;
  /** v1.187.10 — the house panel's reading is fresh (shp2ReadbackFresh: online, a quota (REST or MQTT)
   *  within SHP2_READBACK_STALE_MS, not replaying a cloud shadow). Its grid power, grid status,
   *  backup pool and per-circuit watts are a reading only then; otherwise they are the last
   *  projection, frozen. The lifetime counters and the reserve/strategy settings are not governed. */
  panelLive: boolean;
  /** v1.186.0 — the alarm monitor's set is COMPLETE (snapshot.alertsComplete): a pass on a
   *  hydrated store with every worker/NWS feed delivered, or its bound passed. `alerts` merely
   *  set is not enough: the first publish carries only the live alarms, and counts taken from
   *  it went X → 0 → X across a restart (the v1.178.0 dip this gate exists to remove). */
  alerts: boolean;
  /** The audible-health probe has run at least once. */
  speakers: boolean;
  /** The forecast had PV history to project from. v1.187.10 — and was not built while a home
   *  Core's first reading was pending (DayForecast.homeBasisPending): the boot forecast the
   *  worker builds on a map holding the panel and none of its Cores projected a 0 % low. */
  forecastPv: boolean;
  /** v1.187.10 — the runway was not computed on a home basis still pending
   *  (RunwayProjection.basisPending). */
  runwayBasis: boolean;
  /** The clipping report ran on a real solar model (array peak > 0). */
  clipping: boolean;
  /** The curtailment report ran with home Cores, the panel, weather and a solar posterior. */
  curtailment: boolean;
  /** The carbon report's rolling window ran with Cores and a panel. */
  carbon: boolean;
  /** The tariff report ran with Cores and a panel. */
  tariff: boolean;
  /** v1.187.18 — the degradation report was not built on a device map still filling
   *  (FleetDegradation.basisPending: a Core or panel listed online had no projection yet). */
  degradation: boolean;
}

/** Keys each readiness flag governs, across BOTH publishers (a key absent from a payload is
 *  simply skipped). Lifetime counters are deliberately absent: they come from the recorder's
 *  persisted accumulators and are real at boot. */
export const READINESS_FIELDS: { readonly [K in keyof PublishReadiness]: readonly string[] } = {
  flow: ['fleet_total_in_watts', 'fleet_total_out_watts', 'ac_import_watts'],
  // v1.188.1 — the two power sensors the Energy dashboard's Now view rates solar and battery on.
  flowBridged: ['fleet_pv_watts', 'fleet_battery_net_watts'],
  panel: ['panel_load_watts'],
  // v1.187.10 — the house panel's live figures. `circuit_<ch>_watts` keys are dynamic: see
  // READINESS_PATTERNS. Not backup_full_capacity_kwh / backup_reserve_percent (settings, not
  // readings) and never the lifetime counters.
  panelLive: [
    'grid_home_watts', 'shp2_grid_status', 'backup_pool_percent', 'backup_remaining_kwh',
    'backup_charge_minutes', 'backup_discharge_minutes',
  ],
  alerts: [
    'alert_critical_count', 'alert_warning_count', 'alert_info_count',
    'learned_critical_count', 'learned_warning_count', 'learned_info_count',
    'alert_high_count', 'alert_medium_count', 'alert_low_count',
  ],
  speakers: ['audible_usable_speakers'],
  forecastPv: ['forecast_pv_next_24h_kwh', 'typical_pv_per_day_kwh', 'projected_low_soc_percent', 'projected_low_soc_at'],
  runwayBasis: ['runway_to_reserve_hours', 'runway_to_empty_hours', 'runway_recent_load_watts', 'runway_forecast_pv_used_kwh'],
  clipping: ['pv_clipped_kwh_today', 'pv_array_peak_watts', 'pv_hours_at_peak_today'],
  curtailment: [
    'pv_curtailment_active', 'pv_curtailment_surplus_watts', 'pv_curtailment_kwh_today',
    'pv_curtailment_kwh_7d',
    // Not pv_curtailment_charge_ceiling_pct: the Cores' live chgMaxSoc, null when unknown
    // (the empty report included), never a model-less 0 — and needs no weather.
  ],
  carbon: ['carbon_kg_avoided_7d'],
  tariff: ['tariff_today_grid_cost_dollars', 'tariff_today_solar_value_dollars', 'tariff_net_savings_7d_dollars'],
  degradation: [
    'degradation_packs_total', 'degradation_packs_projecting', 'degradation_soonest_eol_years',
    'degradation_soonest_eol_date', 'degradation_soonest_eol_pack', 'degradation_peer_outliers',
  ],
};

/** v1.187.10 — dynamic keys a flag governs, matched against every key of the payload. The
 *  per-circuit watts are enumerated from the live circuits plus the persisted accumulators
 *  (circuitChannels), so they cannot be listed. `circuit_<ch>_lifetime_kwh` is not matched. */
export const READINESS_PATTERNS: { readonly [K in keyof PublishReadiness]?: readonly RegExp[] } = {
  panelLive: [/^circuit_\d+_watts$/],
};

type Projected = {
  sn?: string; online?: boolean; lastQuotaAtMs?: number; contentStaleSinceMs?: number | null;
  projection?: { kind?: string; circuits?: Array<{ watts?: number | null }> };
};

export interface ReadinessInputs {
  devices: Record<string, Projected>;
  alerts: unknown[] | undefined;
  /** v1.186.0 — FleetSnapshot.alertsComplete; absent reads as not complete. */
  alertsComplete?: boolean;
  speakerLastProbeAt: number | null | undefined;
  forecast: { pvForecastUnavailable?: boolean; homeBasisPending?: boolean } | null | undefined;
  /** v1.187.10 — the runway report; absent or null reads as not ready (its fields are null). */
  runway: { basisPending?: boolean } | null | undefined;
  clipping: { arrayPeakW?: number | null } | null | undefined;
  curtailment: { basisComplete?: boolean } | null | undefined;
  carbon: { basisComplete?: boolean } | null | undefined;
  tariff: { basisComplete?: boolean } | null | undefined;
  /** v1.187.18 — the degradation report; absent or null reads as not ready (its fields are null). */
  degradation: { basisPending?: boolean } | null | undefined;
  /** v1.187.10 — the clock the panel's freshness is judged on (default: now). */
  nowMs?: number;
  /** v1.188.1 — the publisher's bridged flow (Recorder.bridgedFleetFlow), precomputed so this
   *  stays pure. Absent: `flowBridged` reads exactly as `flow`. `ownCores`: home Cores counted at
   *  their own reading (a Core the cloud lists offline whose MQTT data still arrives among them). */
  flowBridge?: { bridgedSlots: number; ownCores?: number; ready: boolean } | null;
}

export function publishReadiness(i: ReadinessInputs): PublishReadiness {
  const devs = Object.values(i.devices);
  const asSnapshots = i.devices as unknown as Record<string, DeviceSnapshot>;
  // v1.185.0 — the house panel; and the union roster is known only once EVERY panel on the account
  // has a projection (a second panel's Cores are missing from it until then). One panel: identical.
  const panel = findShp2(asSnapshots);
  const connected = shp2ConnectedDpuSns(asSnapshots);
  const membershipKnown = shp2Panels(asSnapshots).sns.every((sn) => asSnapshots[sn]?.projection?.kind === 'shp2');
  const nowMs = i.nowMs ?? Date.now();
  const r: PublishReadiness = {
    flow: membershipKnown && Object.entries(i.devices).some(([sn, d]) => d.online && d.projection?.kind === 'dpu' && isShp2Connected(d.sn ?? sn, connected)),
    flowBridged: false, // below: it builds on `flow`
    panel: !!panel && (panel.projection?.circuits ?? []).some((c) => c.watts != null)
      && allShp2s(asSnapshots).every((p) => shp2ReadbackFresh(p, nowMs)),
    panelLive: !!panel && shp2ReadbackFresh(panel, nowMs),
    alerts: i.alerts !== undefined && i.alertsComplete === true,
    speakers: i.speakerLastProbeAt != null,
    forecastPv: !!i.forecast && i.forecast.pvForecastUnavailable !== true && i.forecast.homeBasisPending !== true,
    runwayBasis: !!i.runway && i.runway.basisPending !== true,
    clipping: (i.clipping?.arrayPeakW ?? 0) > 0,
    curtailment: !!i.curtailment && i.curtailment.basisComplete === true,
    carbon: !!i.carbon && i.carbon.basisComplete !== false,
    tariff: !!i.tariff && i.tariff.basisComplete !== false,
    degradation: !!i.degradation && i.degradation.basisPending !== true,
  };
  // v1.188.1 — something is summed (an online home Core, a home Core at its own reading, or a slot
  // the bridge meters), membership is known, and every connected home Core is counted right now:
  // none inside the dwell, no dark slot unbridgeable (fb.ready).
  const fb = i.flowBridge;
  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && (fb.bridgedSlots > 0 || (fb.ownCores ?? 0) > 0))) && fb.ready;
  return r;
}

/** Null every governed field whose readiness flag is false. Mutates and returns `state`. */
export function withholdUnready<T extends Record<string, unknown>>(state: T, r: PublishReadiness): T {
  for (const flag of Object.keys(READINESS_FIELDS) as Array<keyof PublishReadiness>) {
    if (r[flag]) continue;
    for (const key of READINESS_FIELDS[flag]) {
      if (key in state) (state as Record<string, unknown>)[key] = null;
    }
    const patterns = READINESS_PATTERNS[flag];
    if (patterns) {
      for (const key of Object.keys(state)) {
        if (patterns.some((p) => p.test(key))) (state as Record<string, unknown>)[key] = null;
      }
    }
  }
  return state;
}
