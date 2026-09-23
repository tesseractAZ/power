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
 * while its own data is missing, so nothing is held back that is real — alarm counts publish
 * the moment the monitor has run, even while the analytics worker is still cold.
 */

export interface PublishReadiness {
  /** A home Core has a projection: fleet flows are sums over real readings. */
  flow: boolean;
  /** The panel has a projection with at least one reported channel. */
  panel: boolean;
  /** The alarm monitor has evaluated at least once (snapshot.alerts set). */
  alerts: boolean;
  /** The audible-health probe has run at least once. */
  speakers: boolean;
  /** The forecast had PV history to project from. */
  forecastPv: boolean;
  /** The clipping report ran on a real solar model (array peak > 0). */
  clipping: boolean;
  /** The curtailment report ran with home Cores, the panel, weather and a solar posterior. */
  curtailment: boolean;
  /** The carbon report's rolling window ran with Cores and a panel. */
  carbon: boolean;
  /** The tariff report ran with Cores and a panel. */
  tariff: boolean;
}

/** Keys each readiness flag governs, across BOTH publishers (a key absent from a payload is
 *  simply skipped). Lifetime counters are deliberately absent: they come from the recorder's
 *  persisted accumulators and are real at boot. */
export const READINESS_FIELDS: { readonly [K in keyof PublishReadiness]: readonly string[] } = {
  flow: ['fleet_pv_watts', 'fleet_total_in_watts', 'fleet_total_out_watts', 'fleet_battery_net_watts', 'ac_import_watts'],
  panel: ['panel_load_watts'],
  alerts: [
    'alert_critical_count', 'alert_warning_count', 'alert_info_count',
    'learned_critical_count', 'learned_warning_count', 'learned_info_count',
    'alert_high_count', 'alert_medium_count', 'alert_low_count',
  ],
  speakers: ['audible_usable_speakers'],
  forecastPv: ['forecast_pv_next_24h_kwh', 'typical_pv_per_day_kwh'],
  clipping: ['pv_clipped_kwh_today', 'pv_array_peak_watts', 'pv_hours_at_peak_today'],
  curtailment: [
    'pv_curtailment_active', 'pv_curtailment_surplus_watts', 'pv_curtailment_kwh_today',
    'pv_curtailment_kwh_7d', 'pv_curtailment_charge_ceiling_pct',
  ],
  carbon: ['carbon_kg_avoided_7d'],
  tariff: ['tariff_today_grid_cost_dollars', 'tariff_today_solar_value_dollars', 'tariff_net_savings_7d_dollars'],
};

type Projected = { online?: boolean; projection?: { kind?: string; circuits?: Array<{ watts?: number | null }> } };

export interface ReadinessInputs {
  devices: Record<string, Projected>;
  alerts: unknown[] | undefined;
  speakerLastProbeAt: number | null | undefined;
  forecast: { pvForecastUnavailable?: boolean } | null | undefined;
  clipping: { arrayPeakW?: number | null } | null | undefined;
  curtailment: { basisComplete?: boolean } | null | undefined;
  carbon: { basisComplete?: boolean } | null | undefined;
  tariff: { basisComplete?: boolean } | null | undefined;
}

export function publishReadiness(i: ReadinessInputs): PublishReadiness {
  const devs = Object.values(i.devices);
  const panel = devs.find((d) => d.projection?.kind === 'shp2');
  return {
    flow: devs.some((d) => d.online && d.projection?.kind === 'dpu'),
    panel: !!panel && (panel.projection?.circuits ?? []).some((c) => c.watts != null),
    alerts: i.alerts !== undefined,
    speakers: i.speakerLastProbeAt != null,
    forecastPv: !!i.forecast && i.forecast.pvForecastUnavailable !== true,
    clipping: (i.clipping?.arrayPeakW ?? 0) > 0,
    curtailment: !!i.curtailment && i.curtailment.basisComplete === true,
    carbon: !!i.carbon && i.carbon.basisComplete !== false,
    tariff: !!i.tariff && i.tariff.basisComplete !== false,
  };
}

/** Null every governed field whose readiness flag is false. Mutates and returns `state`. */
export function withholdUnready<T extends Record<string, unknown>>(state: T, r: PublishReadiness): T {
  for (const flag of Object.keys(READINESS_FIELDS) as Array<keyof PublishReadiness>) {
    if (r[flag]) continue;
    for (const key of READINESS_FIELDS[flag]) {
      if (key in state) (state as Record<string, unknown>)[key] = null;
    }
  }
  return state;
}
