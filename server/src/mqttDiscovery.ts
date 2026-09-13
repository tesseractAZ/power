import mqtt, { MqttClient } from 'mqtt';
import { liveHostTemp } from './hostThermal.js';
import { liveVitals } from './selfVitals.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { Recorder } from './recorder.js';
import { getAnalytics } from './analyticsClient.js';
import type { Shp2Projection } from './ecoflow/project.js';
import { aggregateFleetFlow } from './shp2Membership.js';
import { kwh1, makeLifetimeKwh, makeAlertCounter, soonestProjecting } from './haPayloadFmt.js';
import { rateAt, apsREvModelFromEnv } from './tariff.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
  computeCarbonReport,
  computeTariffReport,
  runwayHoursForPublish,
} from './analytics.js';
// v0.11.0 — mirror the per-ISA-priority alarm on/off toggles as HA switch
// entities and the per-priority alarm counts as sensors.
import { ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META, priorityOf, type AlarmPriority } from './alertPriority.js';
import { getAlertSettings, updateAlertSettings, onAlertSettingsChange } from './alertSettings.js';
import { advisoryStateFields, getLatestAdvisory } from './loadShedAdvisor.js';
// v1.38.0 — night-charge TOU-arbitrage advisory (design §4.1). State fields carry
// the plan's target SoC / buy kWh / window / charge_tonight (12 h staleness guard,
// charge_tonight strictly false on a null/stale plan); gate fields carry the
// write-readiness enum + fail-closed write_ready. Both wired into buildState so
// the HA night-charge entities have data (read-only; the add-on never charges).
import { nightChargeStateFields, getLatestNightChargePlan } from './nightChargeAdvisor.js';
import { nightChargeGateFields, getLatestReadiness } from './nightChargeGate.js';
// v0.15.19 — lighting energy posture (runway-driven; see lightingPosture.ts).
import { lightingPostureTracker } from './lightingPosture.js';
import { belowReserveFloor } from './runwayAlarm.js';
import { liveGridBackstop } from './gridState.js';
import { countCloudWedges } from './deviceLink.js';
import { systemOutageFields } from './alerts.js';
import { getBroadcastHealth } from './broadcastHealth.js';
import { pollHealth } from './telemetryBlind.js';

/**
 * MQTT Discovery publisher for Home Assistant (v0.7.5).
 *
 * Drops the `configuration.yaml` REST-sensor snippet — when this is wired to
 * the user's HA MQTT broker (e.g., the official `core-mosquitto` add-on), HA
 * auto-discovers every sensor we expose. The user just sees them appear under
 * the "EcoFlow Panel" device.
 *
 * Off by default. Set MQTT_DISCOVERY_ENABLED=1 plus host/user/pass to enable.
 *
 * Topic scheme (HA's convention):
 *   <prefix>/sensor/<id>/config  — entity definition (retained)
 *   ecoflow_panel/state           — one big JSON state payload (published every PUBLISH_INTERVAL_MS)
 * Each sensor's config references `state_topic = ecoflow_panel/state` and
 * extracts its field via `value_template`. One state-topic update refreshes
 * every entity at once.
 */

export const DEVICE_INFO = {
  identifiers: ['ecoflow_panel'],
  name: 'EcoFlow Panel',
  model: 'SHP2 + Delta Pro Ultra fleet dashboard',
  manufacturer: 'EcoFlow Panel (add-on)',
  // v1.134.0 — was the literal '0.8.0' against a shipping 1.133.x, so the HA
  // device page reported a version from ~125 releases earlier. BUILD_VERSION is
  // already a container ENV (Dockerfile) and already read by /api/version.
  // NOT package.json — that reads 0.1.0.
  sw_version: process.env.BUILD_VERSION || 'dev',
};

const STATE_TOPIC = 'ecoflow_panel/state';
const AVAILABILITY_TOPIC = 'ecoflow_panel/availability';
// v0.52.0 — the availability triple repeated verbatim in all four discovery-cfg
// literals (SENSORS / BINARY_SENSORS / switch / planCircuitDiscovery). Spread as
// `...AVAILABILITY_BASE` at the SAME position the three keys occupied so the
// serialized JSON key order — and thus the retained MQTT payload bytes — is
// byte-identical. `device: DEVICE_INFO` is intentionally NOT folded in here: it
// sits at the END of each cfg (after expire_after / device_class / icon / etc.),
// so bundling it would move it ahead of those keys and change the payload bytes.
const AVAILABILITY_BASE = {
  availability_topic: AVAILABILITY_TOPIC,
  payload_available: 'online',
  payload_not_available: 'offline',
} as const;
const PUBLISH_INTERVAL_MS = 30 * 1000;
// v0.13.7 — seconds after which HA marks a sensor unavailable if its state
// stops updating. ~4× the publish interval, so a single slow tick won't trip
// it but a genuinely stalled publisher (the mqtt client stays connected while
// publishState silently no-ops) surfaces as `unavailable` instead of a frozen
// last value. Applied ONLY to live-measurement sensors — NEVER to the
// `total_increasing` lifetime-energy / per-circuit sensors, since an expiring
// long-term-statistics source would create gaps in the HA Energy dashboard.
const EXPIRE_AFTER_S = 120;
// v1.38.0 — the night-charge advisory sensors are refreshed once per evening
// (~21:30), so the 120 s live-sensor expiry would mark them unavailable within
// minutes. A ~25 h expiry (design §4.1 / invariant I12) tolerates the normal
// once-a-day update cadence yet STILL flips the entities to UNAVAILABLE if the
// advisor dies (daily power-cycle, crash, wedge) — so HA never serves a retained
// `charge_tonight=ON` from a dead advisor instead of the honest 'unavailable'.
const NIGHT_CHARGE_EXPIRE_AFTER_S = 90_000;

// v0.11.0 — per-priority alarm on/off switch topics. Each ISA priority gets a
// dedicated state + command topic under the same `ecoflow_panel` base prefix
// the other entities use. The switch object/unique id is `ecoflow_alerts_<p>`.
const alertSwitchUniqueId = (p: AlarmPriority) => `ecoflow_alerts_${p}`;
export const alertSwitchStateTopic = (p: AlarmPriority) => `ecoflow_panel/alerts/${p}/state`;
export const alertSwitchCommandTopic = (p: AlarmPriority) => `ecoflow_panel/alerts/${p}/set`;
const SWITCH_ON = 'ON';
const SWITCH_OFF = 'OFF';

// v0.76.0 — pure, testable extraction of the alarm-priority MQTT switch-command
// logic that was previously inlined in the startMqttDiscovery closure. This is
// the alarm-safety-relevant path: an incoming HA switch ON/OFF must map to the
// correct ISA priority and enable/disable flag so a muted alarm priority can be
// reliably RE-ENABLED. Kept side-effect-free so the runtime handler (which calls
// updateAlertSettings + publishes the echo) and the tests share one code path.

/**
 * Resolve an MQTT command topic back to the ISA priority it controls.
 * Returns undefined for any topic that is not a per-priority command topic
 * (e.g. the STATE-topic echo, or an unrelated subscription) — the caller
 * treats undefined as a no-op, so this never feeds the state echo back into a
 * command (no feedback loop).
 */
export function commandTopicToPriority(topic: string): AlarmPriority | undefined {
  for (const p of ALARM_PRIORITY_ORDER) {
    if (alertSwitchCommandTopic(p) === topic) return p;
  }
  return undefined;
}

/** Result of parsing an alarm-switch command: which priority and whether to enable it. */
export interface AlertSwitchCommand {
  priority: AlarmPriority;
  enabled: boolean;
}

/**
 * Pure parse of an incoming switch command (topic + raw payload) into the
 * priority/enabled pair the runtime feeds to updateAlertSettings. Returns null
 * for a no-op:
 *   • topic is not a per-priority command topic, OR
 *   • payload (after trim + upper-case) is neither ON nor OFF (unknown payload
 *     is a safe no-op — we never guess a default that could silence an alarm).
 */
export function parseAlertSwitchCommand(topic: string, payloadRaw: string): AlertSwitchCommand | null {
  const priority = commandTopicToPriority(topic);
  if (!priority) return null;
  const payload = payloadRaw.trim().toUpperCase();
  if (payload !== SWITCH_ON && payload !== SWITCH_OFF) return null;
  return { priority, enabled: payload === SWITCH_ON };
}

export interface SensorConfig {
  unique_id: string;
  name: string;
  device_class?: string;
  state_class?: string;
  unit_of_measurement?: string;
  icon?: string;
  value_template: string;
  entity_category?: 'diagnostic' | 'config';
  // v1.38.0 — per-sensor override of the default `expire_after` (the night-charge
  // advisory sensors carry a ~25 h expiry, not the 120 s live-sensor default; see
  // NIGHT_CHARGE_EXPIRE_AFTER_S). When unset, publishDiscovery falls back to the
  // legacy rule (EXPIRE_AFTER_S for non-total_increasing sensors, none otherwise).
  expire_after?: number;
}

export const SENSORS: SensorConfig[] = [
  // Power flow
  { unique_id: 'ecoflow_fleet_pv_watts', name: 'Fleet PV', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.fleet_pv_watts }}' },
  { unique_id: 'ecoflow_panel_load_watts', name: 'Panel Load', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.panel_load_watts }}' },
  { unique_id: 'ecoflow_ac_import_watts', name: 'AC Import', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.ac_import_watts }}' },
  { unique_id: 'ecoflow_fleet_battery_net_watts', name: 'Battery Net', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.fleet_battery_net_watts }}' },
  // v0.48.0 — whole-home grid POWER at the SHP2 main (wattInfo.gridWatt). The
  // power complement of the grid_to_home lifetime energy sensor (v0.44.0).
  // v1.53.0 — the rewire this sensor existed to enable is DONE: the HA Energy
  // Dashboard grid source now carries power_config.stat_rate = this sensor, not
  // DPU ac_in. See §"HA Energy Dashboard wiring" in DOCS.md for the full mapping.
  { unique_id: 'ecoflow_grid_home_watts', name: 'Grid Power (Home)', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', icon: 'mdi:transmission-tower', value_template: '{{ value_json.grid_home_watts }}' },
  // SHP2 backup pool
  { unique_id: 'ecoflow_backup_pool', name: 'Backup Pool', device_class: 'battery', state_class: 'measurement', unit_of_measurement: '%', value_template: '{{ value_json.backup_pool_percent }}' },
  { unique_id: 'ecoflow_backup_remaining_kwh', name: 'Backup Remaining', device_class: 'energy_storage', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.backup_remaining_kwh }}' },
  // v1.2.0 — `energy_storage`, matching its sibling `backup_remaining_kwh` one line up.
  // Without it HA treats a stored-energy kWh as a bare measurement: wrong default icon,
  // and it can't be picked in pickers that filter on the storage device class.
  { unique_id: 'ecoflow_backup_full_capacity_kwh', name: 'Backup Capacity', device_class: 'energy_storage', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.backup_full_capacity_kwh }}' },
  // Forecast
  // v0.15.3 — no device_class: a forecast/rolling kWh is a `measurement` (goes up
  // AND down); device_class energy forces total/total_increasing → HA rejects it.
  { unique_id: 'ecoflow_forecast_pv_next_24h_kwh', name: 'Forecast PV Next 24h', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.forecast_pv_next_24h_kwh }}' },
  { unique_id: 'ecoflow_projected_low_soc', name: 'Projected Low SoC', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-low', value_template: '{{ value_json.projected_low_soc_percent }}' },
  { unique_id: 'ecoflow_soiling_drop_percent', name: 'Solar Soiling', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:weather-dust', value_template: '{{ value_json.soiling_drop_percent }}' },
  // Degradation
  { unique_id: 'ecoflow_degradation_soonest_eol_years', name: 'Soonest Pack EOL', state_class: 'measurement', unit_of_measurement: 'yr', icon: 'mdi:battery-clock', value_template: '{{ value_json.degradation_soonest_eol_years }}' },
  { unique_id: 'ecoflow_degradation_peer_outliers', name: 'Peer-Outlier Packs', state_class: 'measurement', icon: 'mdi:alert-decagram-outline', value_template: '{{ value_json.degradation_peer_outliers }}' },
  // Runway
  { unique_id: 'ecoflow_runway_to_reserve_hours', name: 'Runway to Reserve', state_class: 'measurement', unit_of_measurement: 'h', icon: 'mdi:timer-sand', value_template: '{{ value_json.runway_to_reserve_hours }}' },
  { unique_id: 'ecoflow_runway_to_empty_hours', name: 'Runway to Empty', state_class: 'measurement', unit_of_measurement: 'h', icon: 'mdi:timer-off', value_template: '{{ value_json.runway_to_empty_hours }}' },
  // RTE
  { unique_id: 'ecoflow_round_trip_efficiency', name: 'Round-Trip Efficiency', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-sync-outline', value_template: '{{ value_json.round_trip_efficiency_percent }}' },
  // Clipping
  { unique_id: 'ecoflow_pv_clipped_kwh_today', name: 'PV Clipped Today', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_clipped_kwh_today }}' },
  { unique_id: 'ecoflow_pv_array_peak_watts', name: 'PV Array Peak', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.pv_array_peak_watts }}', entity_category: 'diagnostic' },
  // v0.9.77 — SoC-saturation curtailment ("batteries full, panels throttled")
  { unique_id: 'ecoflow_pv_curtailment_surplus_watts', name: 'PV Curtailment Surplus', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', icon: 'mdi:solar-power-variant', value_template: '{{ value_json.pv_curtailment_surplus_watts }}' },
  { unique_id: 'ecoflow_pv_curtailment_kwh_today', name: 'PV Curtailed Today', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_today }}' },
  // v0.15.3 — measurement (rolling 7-day window goes up and down) → no device_class energy.
  { unique_id: 'ecoflow_pv_curtailment_kwh_7d', name: 'PV Curtailed 7d', state_class: 'measurement', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_7d }}' },
  { unique_id: 'ecoflow_charge_ceiling', name: 'Charge Ceiling', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-charging-100', value_template: '{{ value_json.pv_curtailment_charge_ceiling_pct }}', entity_category: 'diagnostic' },
  // Self-consumption (v0.7.5)
  { unique_id: 'ecoflow_solar_fraction_of_load', name: 'Solar Fraction of Load', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:solar-power', value_template: '{{ value_json.solar_fraction_of_load_percent }}' },
  { unique_id: 'ecoflow_direct_use_ratio', name: 'PV Direct Use Ratio', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:transmission-tower-import', value_template: '{{ value_json.direct_use_ratio_percent }}' },
  // Alert counts — these legacy entity-ids are load-bearing (HA history depends
  // on them); do NOT rename or remove.
  { unique_id: 'ecoflow_alert_critical_count', name: 'Critical Alerts', state_class: 'measurement', icon: 'mdi:alert-octagon', value_template: '{{ value_json.alert_critical_count }}' },
  { unique_id: 'ecoflow_alert_warning_count', name: 'Warning Alerts', state_class: 'measurement', icon: 'mdi:alert', value_template: '{{ value_json.alert_warning_count }}' },
  { unique_id: 'ecoflow_learned_warning_count', name: 'Learned Warnings', state_class: 'measurement', icon: 'mdi:lightbulb-on', value_template: '{{ value_json.learned_warning_count }}' },
  // v0.11.0 — additive per-ISA-priority alarm counts (Critical already exposed
  // above via alert_critical_count; these cover High/Medium/Low). Derived from
  // priorityOf(alert) so they track the same 4-tier taxonomy as the switches.
  { unique_id: 'ecoflow_alert_high_count', name: 'High Priority Alarms (P2)', state_class: 'measurement', icon: 'mdi:alert', value_template: '{{ value_json.alert_high_count }}' },
  { unique_id: 'ecoflow_alert_medium_count', name: 'Medium Priority Alarms (P3)', state_class: 'measurement', icon: 'mdi:alert-outline', value_template: '{{ value_json.alert_medium_count }}' },
  { unique_id: 'ecoflow_alert_low_count', name: 'Low Priority Alarms (P4)', state_class: 'measurement', icon: 'mdi:information-outline', value_template: '{{ value_json.alert_low_count }}' },
  // Fleet
  { unique_id: 'ecoflow_fleet_devices_online', name: 'Fleet Devices Online', state_class: 'measurement', icon: 'mdi:home-battery', value_template: '{{ value_json.fleet_devices_online }}' },
  // Cloud-wedge diagnostic: count of devices the EcoFlow cloud reports OFFLINE but
  // that are still reachable on the LAN (per the operator's HA ping binary_sensors
  // mapped via ECOFLOW_DEVICE_REACHABILITY) — i.e. an EcoFlow cloud-session/MQTT
  // wedge rather than a real power/network outage. Reads 0 when the feature is
  // unconfigured. Diagnostic so it sits under the device's diagnostics, not the
  // primary controls.
  { unique_id: 'ecoflow_cloud_wedge_count', name: 'Cloud-Wedged Devices', state_class: 'measurement', icon: 'mdi:cloud-alert', entity_category: 'diagnostic', value_template: '{{ value_json.ecoflow_cloud_wedge_count }}' },
  // v1.140.0 — the poll-health verdict, so an SHP2-dark window leaves EVIDENCE
  // rather than an inference. S1 had to be argued from code reading because this
  // value was computed every 60 s and stored nowhere. No unit: it is an enum.
  { unique_id: 'ecoflow_poll_health', name: 'Poll Health', icon: 'mdi:radar', entity_category: 'diagnostic', value_template: '{{ value_json.poll_health }}' },
  // v1.142.0 — how long the SHP2's payload has been byte-identical. 0 = moving.
  // The cloud-shadow freeze was invisible from outside the add-on; this is the
  // instrument that makes the next one observable in HA's own history.
  { unique_id: 'ecoflow_shp2_content_frozen_s', name: 'SHP2 Payload Frozen', state_class: 'measurement', unit_of_measurement: 's', icon: 'mdi:content-duplicate', entity_category: 'diagnostic', value_template: '{{ value_json.shp2_content_frozen_s }}' },
  // v0.83.0 — system data-gap / unplanned-outage TRACKING (24 h). Recorded
  // telemetry blackouts (restart-spanning gaps ≥ 5 min — power loss, add-on stop,
  // or deploy — and in-process MQTT stalls > 15 min). A binary "system outage in
  // the last 24 h" flag + count + total minutes so an operator can watch the
  // trend after a UPS/power fix. Diagnostic; all 0 = clean.
  // Plain ON/OFF diagnostic (no device_class 'problem' — matches the coverage_partial
  // sibling convention; the operator FLAG is the push alert, this is a status tile).
  { unique_id: 'ecoflow_system_outage_24h', name: 'System Outage (24h)', icon: 'mdi:power-plug-off', entity_category: 'diagnostic', value_template: '{{ "ON" if value_json.system_outage_active_24h else "OFF" }}' },
  { unique_id: 'ecoflow_system_outage_count_24h', name: 'System Outages 24h', state_class: 'measurement', icon: 'mdi:counter', entity_category: 'diagnostic', value_template: '{{ value_json.system_outage_count_24h }}' },
  // v1.4.1 (daytime-review #4) — split the 24h total by cause so a cloud/MQTT stall (process
  // stayed up) is not read as a power event (add-on/host was down across the gap).
  { unique_id: 'ecoflow_system_power_outage_count_24h', name: 'Power Outages 24h', state_class: 'measurement', icon: 'mdi:power-plug-off', entity_category: 'diagnostic', value_template: '{{ value_json.system_power_outage_count_24h }}' },
  { unique_id: 'ecoflow_system_telemetry_gap_count_24h', name: 'Telemetry Gaps 24h', state_class: 'measurement', icon: 'mdi:cloud-off-outline', entity_category: 'diagnostic', value_template: '{{ value_json.system_telemetry_gap_count_24h }}' },
  // v1.155.0 — per-device telemetry gaps: one device silent past the per-device
  // threshold while the rest of the fleet kept reporting. Not an outage, so it is kept
  // out of every outage tile above and counted here instead.
  { unique_id: 'ecoflow_system_device_gap_count_24h', name: 'Device Telemetry Gaps 24h', state_class: 'measurement', icon: 'mdi:access-point-network-off', entity_category: 'diagnostic', value_template: '{{ value_json.system_device_gap_count_24h }}' },
  { unique_id: 'ecoflow_system_outage_minutes_24h', name: 'System Outage Minutes 24h', state_class: 'measurement', unit_of_measurement: 'min', icon: 'mdi:timer-alert-outline', entity_category: 'diagnostic', value_template: '{{ value_json.system_outage_total_minutes_24h }}' },
  // v0.84.0 — audible-delivery health. `audible_status` is reachable / UNREACHABLE
  // / disabled / unknown so an operator can alert on a dead audible channel (MA
  // down → speakers unavailable) that would otherwise be invisible; the paired
  // count shows how many configured speakers are currently reachable.
  { unique_id: 'ecoflow_audible_channel_status', name: 'Audible Alarm Channel', icon: 'mdi:speaker-wireless', entity_category: 'diagnostic', value_template: '{{ value_json.audible_status }}' },
  { unique_id: 'ecoflow_audible_speakers_reachable', name: 'Audible Speakers Reachable', state_class: 'measurement', icon: 'mdi:speaker-multiple', entity_category: 'diagnostic', value_template: '{{ value_json.audible_usable_speakers }}' },
  // ─── HA Energy Dashboard — monotonic lifetime counters (v0.7.6) ──────────
  // state_class: total_increasing tells HA to treat decreases as resets and
  // accumulate the per-hour delta into long-term Energy statistics.
  { unique_id: 'ecoflow_pv_lifetime_kwh', name: 'PV Production', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power', value_template: '{{ value_json.pv_lifetime_kwh }}' },
  { unique_id: 'ecoflow_load_lifetime_kwh', name: 'Home Consumption', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:home-lightning-bolt', value_template: '{{ value_json.load_lifetime_kwh }}' },
  // v0.44.0 — naming honesty for the HA Energy Dashboard "Grid consumption" slot.
  // `grid_import_lifetime_kwh` is DPU `ac_in` — grid energy that AC-CHARGES the
  // batteries — NOT whole-home grid import. On a solar-charged home it sits near
  // zero, so wiring it as grid consumption shows ~0 kWh. It's a diagnostic
  // sub-metric, renamed + demoted so it's no longer the obvious (wrong) pick.
  { unique_id: 'ecoflow_grid_import_lifetime_kwh', name: 'Grid to Battery Charge', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:battery-charging-outline', entity_category: 'diagnostic', value_template: '{{ value_json.grid_import_lifetime_kwh }}' },
  // `grid_to_home_lifetime_kwh` is the SHP2-main meter (wattInfo.gridWatt) — the
  // TRUE whole-home grid import. This is the sensor to wire into HA Energy →
  // Grid consumption. Named/iconed as the canonical "Grid Import" accordingly.
  { unique_id: 'ecoflow_grid_to_home_lifetime_kwh', name: 'Grid Import (Home)', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:transmission-tower-import', value_template: '{{ value_json.grid_to_home_lifetime_kwh }}' },
  { unique_id: 'ecoflow_battery_charge_lifetime_kwh', name: 'Battery Energy In', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:battery-charging', value_template: '{{ value_json.battery_charge_lifetime_kwh }}' },
  { unique_id: 'ecoflow_battery_discharge_lifetime_kwh', name: 'Battery Energy Out', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:battery-arrow-down', value_template: '{{ value_json.battery_discharge_lifetime_kwh }}' },

  // ─── v0.8.0 sustainability + tariff ──────────────────────────────────────
  { unique_id: 'ecoflow_carbon_kg_avoided_7d', name: 'CO2 Avoided (7d)', state_class: 'measurement', unit_of_measurement: 'kg', icon: 'mdi:leaf', value_template: '{{ value_json.carbon_kg_avoided_7d }}' },
  { unique_id: 'ecoflow_carbon_lifetime_kg', name: 'CO2 Avoided Lifetime', state_class: 'total_increasing', unit_of_measurement: 'kg', icon: 'mdi:leaf', value_template: '{{ value_json.carbon_lifetime_kg_avoided }}' },
  { unique_id: 'ecoflow_carbon_lifetime_miles', name: 'Equivalent Miles Not Driven', state_class: 'total_increasing', unit_of_measurement: 'mi', icon: 'mdi:car-electric', value_template: '{{ value_json.carbon_lifetime_miles_not_driven }}' },
  { unique_id: 'ecoflow_tariff_today_cost', name: 'Grid Cost Today', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash', value_template: '{{ value_json.tariff_today_grid_cost_dollars }}' },
  { unique_id: 'ecoflow_tariff_today_saved', name: 'Solar Value Today', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash-plus', value_template: '{{ value_json.tariff_today_solar_value_dollars }}' },
  { unique_id: 'ecoflow_tariff_savings_7d', name: 'Net Savings (7d)', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash-check', value_template: '{{ value_json.tariff_net_savings_7d_dollars }}' },

  // ─── v1.134.0 — the live per-kWh rate, for HA's Energy Dashboard ──────────
  //
  // This is the ENABLING entity for grid cost on the Energy page. HA renders a
  // cost column only if one of `stat_cost`, `entity_energy_price` or
  // `number_energy_price` is set on the grid source; all three were null, so the
  // page showed no money at all despite a confirmed five-rate tariff.
  //
  // `entity_energy_price` is the only one of the three that is correct on a TOU
  // plan: HA's own cost sensor accrues `(energy − prev) × price` on every state
  // change of the ENERGY entity, sampling this rate fresh each time, so each
  // delta is multiplied by the rate in force while it flowed. A single
  // `number_energy_price` against 8.2–41.6 c/kWh is wrong by construction (a
  // 10 kWh overnight + 10 kWh on-peak day is $5.47; one scalar gives 20p, right
  // only at p = $0.2735 and only for that mix). `stat_cost` would need a
  // monotonic monetary accumulator that does not exist, and the add-on's own
  // cost integrates a SUPERSET of the mapped grid statistic, so money and kWh
  // would not reconcile to any rate.
  //
  // Units are USD/kWh, NOT USD, and there is deliberately no device_class:
  // `monetary` is for an amount of money, not a price, and HA mints its own
  // monetary/total cost sensor from this one.
  { unique_id: 'ecoflow_grid_price_now', name: 'Grid Rate Now', state_class: 'measurement', unit_of_measurement: 'USD/kWh', icon: 'mdi:cash-clock', value_template: '{{ value_json.tariff_rate_now_usd_per_kwh }}' },

  // ─── v0.15.2 load-shedding advisory (read + advise; HA automations actuate) ─
  // The advisor recommends which allowlisted loads to shed when runway is low,
  // with an upper-bound counterfactual. Gate your HA automations on these:
  // e.g. "if load_shed_recommended ON for 5 min then turn off switch.pool_pump".
  { unique_id: 'ecoflow_runway_to_reserve_if_shed_hours', name: 'Runway to Reserve (if shed)', state_class: 'measurement', unit_of_measurement: 'h', icon: 'mdi:timer-sand-complete', value_template: '{{ value_json.runway_to_reserve_if_shed_hours }}' },
  { unique_id: 'ecoflow_load_shed_recommended_count', name: 'Load-Shed Recommended Count', state_class: 'measurement', icon: 'mdi:power-plug-off', value_template: '{{ value_json.load_shed_recommended_count }}' },
  { unique_id: 'ecoflow_load_shed_recommended_watts', name: 'Load-Shed Recommended Watts', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', icon: 'mdi:power-plug-off-outline', value_template: '{{ value_json.load_shed_recommended_watts }}' },

  // ─── v1.38.0 night-charge TOU-arbitrage advisory (ADVISORY / no-write) ──────
  // The advisor sizes an optional cheap-overnight grid buy (APS R-EV 11pm–5am)
  // so tomorrow holds the reserve floor + outage cushion and skips the 4–7pm
  // peak (design §2, §4.1). Read-only: the operator's own HA automation actuates
  // — the add-on NEVER charges. NO device_class (a target that moves up AND down,
  // not an accumulation — buy_kwh MUST NOT be device_class:energy). Readiness +
  // window are plain string sensors. Each carries NIGHT_CHARGE_EXPIRE_AFTER_S
  // (~25 h, I12) so the once-nightly cadence doesn't trip the expiry but a dead
  // advisor still flips these to UNAVAILABLE the next day. Numeric fields emit
  // null (→ HA 'unknown') when the plan is stale/incomplete — never a fabricated
  // value. The AVAILABILITY spread is applied uniformly in publishDiscovery().
  // v1.60.0 — Target SoC is the WRITE SETPOINT (the resilience requirement,
  // already inside the device's [10,50] reserve bound): it is what an advisory-
  // mode automation should set backupReserveSoc to. Expected SoC is the
  // separate, contention-derated PREDICTION of where the pack actually lands.
  // Keeping the ask on the existing entity means a wired automation keeps
  // asking for the requirement instead of silently capping itself at a forecast.
  { unique_id: 'ecoflow_night_charge_target_soc', name: 'Night-Charge Target SoC', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-charging-90', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_target_soc_percent }}' },
  { unique_id: 'ecoflow_night_charge_expected_soc', name: 'Night-Charge Expected SoC', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-clock', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_expected_soc_percent }}' },
  // v1.42.0 — alarm-host SoC temperature (heat tripwire; HA recorder provides
  // the trend history). Null when the host exposes no readable thermal zone.
  { unique_id: 'ecoflow_host_evloop_lag', name: 'Host Event-Loop Lag', state_class: 'measurement', unit_of_measurement: 'ms', icon: 'mdi:timer-sand', entity_category: 'diagnostic', value_template: '{{ value_json.host_evloop_lag_ms }}' },
  { unique_id: 'ecoflow_host_mem_available', name: 'Host Memory Available', state_class: 'measurement', unit_of_measurement: 'MB', icon: 'mdi:memory', entity_category: 'diagnostic', value_template: '{{ value_json.host_mem_available_mb }}' },
  { unique_id: 'ecoflow_host_disk_free', name: 'Host Data Disk Free', state_class: 'measurement', unit_of_measurement: 'MB', icon: 'mdi:harddisk', entity_category: 'diagnostic', value_template: '{{ value_json.host_data_disk_free_mb }}' },
  { unique_id: 'ecoflow_host_load_1m', name: 'Host Load (1m)', state_class: 'measurement', icon: 'mdi:chip', entity_category: 'diagnostic', value_template: '{{ value_json.host_load_1m }}' },
  { unique_id: 'ecoflow_host_soc_temp', name: 'Host SoC Temperature', device_class: 'temperature', state_class: 'measurement', unit_of_measurement: '°C', entity_category: 'diagnostic', value_template: '{{ value_json.host_soc_temp_c }}' },
  { unique_id: 'ecoflow_night_charge_buy_kwh', name: 'Night-Charge Buy', state_class: 'measurement', unit_of_measurement: 'kWh', icon: 'mdi:transmission-tower-import', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_buy_kwh }}' },
  { unique_id: 'ecoflow_night_charge_readiness', name: 'Night-Charge Readiness', icon: 'mdi:clipboard-check-outline', entity_category: 'diagnostic', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_readiness }}' },
  { unique_id: 'ecoflow_night_charge_window_start', name: 'Night-Charge Window Start', icon: 'mdi:clock-start', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_window_start }}' },
  { unique_id: 'ecoflow_night_charge_window_end', name: 'Night-Charge Window End', icon: 'mdi:clock-end', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ value_json.night_charge_window_end }}' },

  // ─── v0.15.19 lighting energy posture (publish-only; HA automations actuate) ─
  // One runway-derived enum (surplus|normal|conserve|amber|red|critical) the
  // home's lighting keys off. Escalation is immediate; de-escalation holds
  // 15 min (lightingPosture.ts). Gate consumers in HA behind
  // input_boolean.lighting_postures_enabled — the add-on never toggles a light.
  { unique_id: 'ecoflow_lighting_posture', name: 'Lighting Posture', icon: 'mdi:lightbulb-auto', value_template: '{{ value_json.lighting_posture }}' },
  { unique_id: 'ecoflow_lighting_posture_reason', name: 'Lighting Posture Reason', icon: 'mdi:information-outline', entity_category: 'diagnostic', value_template: '{{ value_json.lighting_posture_reason }}' },
  // ─── v0.89.0 — SHP2 operating-mode / reserve strategy (diagnostic; publish-only) ──
  // Surface the SHP2's OWN strategy config + grid-line flag as read-only HA
  // diagnostics so an operator/automation can see the backup posture, reserve floor,
  // and grid presence without the web UI. backup_reserve_percent reads the CANONICAL
  // projection.backupReserveSoc (the field the floor alarm + grid-backstop defend
  // with) — NEVER strategy.backupReserveSoc — so it can never disagree with the
  // reserve actually protecting the home. The *_mode_code sensors are RAW SHP2 enum
  // codes: EcoFlow publishes no authoritative value→meaning mapping (live values are
  // smart=2 / backup=0 / overload=0), so they are exposed honestly as integers, not
  // fabricated labels. Numeric-null fields emit null → HA 'unknown' when the SHP2 is
  // cloud-offline (by design, never substitute 0). Use /api/debug/raw?sn=<SHP2> to
  // field-research the codes against the EcoFlow app.
  { unique_id: 'ecoflow_shp2_grid_sta', name: 'SHP2 Grid Status', icon: 'mdi:transmission-tower', entity_category: 'diagnostic', value_template: '{{ value_json.shp2_grid_status }}' },
  { unique_id: 'ecoflow_backup_reserve_percent', name: 'Backup Reserve Floor', device_class: 'battery', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-lock', entity_category: 'diagnostic', value_template: '{{ value_json.backup_reserve_percent }}' },
  { unique_id: 'ecoflow_solar_backup_reserve_percent', name: 'Solar Backup Reserve', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:solar-power-variant', entity_category: 'diagnostic', value_template: '{{ value_json.solar_backup_reserve_percent }}' },
  // v1.3.0 (audit rank 13) — the old template `{{ "ON" if ... else "OFF" }}` collapsed a
  // NULL (SHP2 cloud-offline → no strategy object) into "OFF": it asserted that the backup
  // reserve floor is DISABLED at exactly the moment we cannot see it. A data gap must read
  // `unknown`, never a fabricated safety-off. Matches the null-safe neighbours above.
  { unique_id: 'ecoflow_backup_reserve_enabled', name: 'Backup Reserve Enabled', icon: 'mdi:battery-lock-open', entity_category: 'diagnostic', value_template: '{{ "unknown" if value_json.backup_reserve_enabled is none else ("ON" if value_json.backup_reserve_enabled else "OFF") }}' },
  { unique_id: 'ecoflow_smart_backup_mode_code', name: 'Smart Backup Mode (code)', state_class: 'measurement', icon: 'mdi:home-battery', entity_category: 'diagnostic', value_template: '{{ value_json.smart_backup_mode_code }}' },
  { unique_id: 'ecoflow_backup_mode_code', name: 'Backup Mode (code)', state_class: 'measurement', icon: 'mdi:home-battery-outline', entity_category: 'diagnostic', value_template: '{{ value_json.backup_mode_code }}' },
  { unique_id: 'ecoflow_overload_mode_code', name: 'Overload Mode (code)', state_class: 'measurement', icon: 'mdi:flash-alert', entity_category: 'diagnostic', value_template: '{{ value_json.overload_mode_code }}' },
];

/**
 * v1.137.0 — Table-wide discovery invariants (B3).
 *
 * Home Assistant does not reject an incoherent (device_class, state_class,
 * unit) triple loudly. It either drops the entity with one line in a log
 * nobody reads, or — worse — accepts it and silently compiles the WRONG
 * statistic. Both failures present identically from the add-on's side: the
 * publish succeeds, the topic is retained, and the sensor looks fine.
 *
 * Two live defects came out of exactly this gap:
 *   - v0.15.3: five pv_curtailment_* sensors referenced value_json keys that
 *     buildState never emitted → permanent "unknown".
 *   - v1.134.0: the three USD sensors carry `state_class: measurement` with no
 *     device_class, so HA compiles a MEAN and never a SUM. That is correct for
 *     a dashboard readout and fatal for an Energy-Dashboard cost source — and
 *     nothing in the table said which one was intended.
 *
 * So the rules are asserted over the whole table rather than per-sensor, and a
 * deliberate departure has to be written down as a waiver with a reason. The
 * waiver list is the documentation: adding a fourth USD sensor now forces the
 * author to state which of the two behaviours they want.
 *
 * Pure. Takes the tables as arguments so a test can feed it mutants.
 */
export interface DiscoveryViolation {
  unique_id: string;
  rule: string;
  detail: string;
}

/** device_class -> the state_classes HA permits for it. */
const DEVICE_CLASS_STATE_CLASSES: Record<string, readonly string[]> = {
  battery: ['measurement'],
  energy: ['total', 'total_increasing'],
  energy_storage: ['measurement'],
  monetary: ['total'],
  power: ['measurement'],
  temperature: ['measurement'],
};

/** device_class -> the units HA permits for it (restricted to ones we ship). */
const DEVICE_CLASS_UNITS: Record<string, readonly string[]> = {
  battery: ['%'],
  energy: ['Wh', 'kWh', 'MWh'],
  energy_storage: ['Wh', 'kWh', 'MWh'],
  power: ['W', 'kW', 'MW'],
  temperature: ['°C', '°F', 'K'],
};

/**
 * Units that denote an AMOUNT of money. A sensor carrying one is either an
 * Energy-Dashboard cost source (device_class monetary + state_class total, the
 * only combination HA will sum) or a plain dashboard readout — and which one it
 * is must be stated, not inferred. `USD/kWh` is deliberately absent: that is a
 * PRICE, not an amount, and `monetary` does not apply to it.
 */
const CURRENCY_UNITS: readonly string[] = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

/**
 * Sensors that break a rule on purpose. Each needs a reason, and the reason is
 * the only place the intent is recorded.
 */
const DISCOVERY_WAIVERS: Record<string, { rule: string; reason: string }> = {
  ecoflow_tariff_today_cost: {
    rule: 'currency-needs-monetary-total',
    reason:
      'Dashboard readout, not an Energy-Dashboard source. Resets to 0 each midnight, so it is not monotonic and `total` would make HA book a meter reset every day. HA mints its own monetary/total cost entity from ecoflow_grid_price_now instead (v1.134.0).',
  },
  ecoflow_tariff_today_saved: {
    rule: 'currency-needs-monetary-total',
    reason: 'Same as ecoflow_tariff_today_cost — daily-resetting readout.',
  },
  ecoflow_tariff_savings_7d: {
    rule: 'currency-needs-monetary-total',
    reason:
      'A rolling 7-day window: goes up AND down, so it is a measurement by construction. Never a sum.',
  },
};

/**
 * Returns every violation in the two tables. Empty array = the tables are
 * coherent. Callers should assert emptiness rather than a count, so a NEW
 * violation cannot be masked by removing an old one.
 */
/**
 * v1.137.0 — What has to happen on every broker connect, and what only once (B5).
 *
 * Discovery configs are published RETAINED, so in the ordinary case HA re-reads
 * them from the broker without our help. The case that breaks is when the
 * BROKER loses its retained store — a Mosquitto restart without persistence, a
 * reset persistence file, a re-created container. The retained configs are then
 * gone, and the add-on's one-time `published` latch meant it never re-asserted
 * them: HA would keep whatever it had in its own registry until someone
 * restarted the add-on, and a fresh HA would never learn the entities at all.
 *
 * So `publishDiscovery` runs on EVERY connect. It is ~90 small retained
 * publishes of identical payloads; HA re-processes them as no-ops because the
 * unique_ids and configs are unchanged.
 *
 * Three things deliberately do NOT follow that rule:
 *
 *   - `clearLegacyDiscovery` stays latched. It publishes empty payloads to the
 *     config topics of unique_ids we RETIRED. Those need saying once; repeating
 *     them on every reconnect is pure traffic and would never stop.
 *
 *   - the per-circuit signature IS invalidated, because the circuit configs are
 *     retained on the same broker and vanish with the same store. Its own latch
 *     (`circuitDiscoverySig`) is what gates re-assertion, so clearing it is what
 *     makes the circuits come back.
 *
 *   - the per-circuit CHANNEL LEDGER (`publishedCircuitChannels`) is left
 *     alone. It is not an assert-latch; it is the memory of which circuits we
 *     have published so we can clear the config topic of one that goes away.
 *     Resetting it on connect would forget those, and an orphaned circuit's
 *     retained config would sit on the broker forever with nothing left to
 *     remove it.
 *
 * Takes its effects as callbacks so the sequence is testable without a broker.
 */
export interface ConnectLatch {
  legacyCleared: boolean;
}

export interface ConnectEffects {
  publishAvailability: () => void;
  clearLegacyDiscovery: () => void;
  publishDiscovery: () => void;
  invalidateCircuitDiscovery: () => void;
  subscribeSwitchCommands: () => void;
  publishState: () => void;
  publishSwitchStates: () => void;
}

export function runBrokerConnect(latch: ConnectLatch, fx: ConnectEffects): void {
  // v1.14.1 — availability FIRST and unconditionally. The broker's LWT retains
  // 'offline' when it times the session out (live: a ~95 s event-loop stall at
  // 05:41 on 2026-07-12); leaving that in place holds every entity unavailable.
  fx.publishAvailability();
  if (!latch.legacyCleared) {
    // Retired unique_ids go out BEFORE the canonical configs so HA processes
    // the removal and the (re)publish in the same session.
    fx.clearLegacyDiscovery();
    latch.legacyCleared = true;
  }
  fx.publishDiscovery();
  fx.invalidateCircuitDiscovery();
  // MQTT subscriptions do not survive a clean-session reconnect.
  fx.subscribeSwitchCommands();
  fx.publishState();
  fx.publishSwitchStates();
}

export function auditDiscoveryTables(
  sensors: readonly SensorConfig[],
  binarySensors: readonly BinarySensorConfig[],
  waivers: Record<string, { rule: string; reason: string }> = DISCOVERY_WAIVERS,
): DiscoveryViolation[] {
  const out: DiscoveryViolation[] = [];
  const waived = (unique_id: string, rule: string) =>
    waivers[unique_id]?.rule === rule && (waivers[unique_id]?.reason ?? '').trim().length > 0;
  const add = (unique_id: string, rule: string, detail: string) => {
    if (!waived(unique_id, rule)) out.push({ unique_id, rule, detail });
  };

  // unique_id collisions across BOTH tables: HA keys the entity registry on
  // unique_id per platform, but a collision within a platform silently drops
  // one of the two entities.
  const seenSensor = new Set<string>();
  for (const s of sensors) {
    if (seenSensor.has(s.unique_id)) add(s.unique_id, 'duplicate-unique-id', 'appears twice in SENSORS');
    seenSensor.add(s.unique_id);
  }
  const seenBinary = new Set<string>();
  for (const b of binarySensors) {
    if (seenBinary.has(b.unique_id)) add(b.unique_id, 'duplicate-unique-id', 'appears twice in BINARY_SENSORS');
    seenBinary.add(b.unique_id);
  }

  for (const s of sensors) {
    const { unique_id, device_class: dc, state_class: sc, unit_of_measurement: unit } = s;

    if (dc) {
      const allowedSc = DEVICE_CLASS_STATE_CLASSES[dc];
      if (allowedSc && (!sc || !allowedSc.includes(sc))) {
        add(unique_id, 'device-class-state-class', `device_class '${dc}' requires state_class in [${allowedSc.join(', ')}], got '${sc ?? 'none'}'`);
      }
      const allowedUnits = DEVICE_CLASS_UNITS[dc];
      if (allowedUnits && (!unit || !allowedUnits.includes(unit))) {
        add(unique_id, 'device-class-unit', `device_class '${dc}' requires unit in [${allowedUnits.join(', ')}], got '${unit ?? 'none'}'`);
      }
    }

    // A unit with no state_class compiles NO long-term statistics at all. That
    // is almost never intended for a numeric sensor and is invisible until
    // someone opens the Statistics developer tool.
    if (unit && !sc) {
      add(unique_id, 'unit-without-state-class', `unit '${unit}' with no state_class compiles no statistics`);
    }

    // `total_increasing` on a dimensionless sensor sums a unitless number,
    // which the Energy Dashboard cannot consume and the history graph
    // mis-labels.
    if (sc === 'total_increasing' && !unit) {
      add(unique_id, 'total-increasing-without-unit', 'state_class total_increasing requires a unit');
    }

    if (unit && CURRENCY_UNITS.includes(unit) && !(dc === 'monetary' && sc === 'total')) {
      add(unique_id, 'currency-needs-monetary-total', `unit '${unit}' is an amount of money; HA sums it only as device_class 'monetary' + state_class 'total' (got '${dc ?? 'none'}' / '${sc ?? 'none'}')`);
    }
  }

  return out;
}

export interface BinarySensorConfig {
  unique_id: string;
  name: string;
  device_class?: string;
  icon?: string;
  value_template: string;
  entity_category?: 'diagnostic' | 'config';
  // v1.38.0 — per-sensor `expire_after` override (night-charge advisory flags use
  // ~25 h; every other binary uses the 120 s live default). See publishDiscovery.
  expire_after?: number;
}

export const BINARY_SENSORS: BinarySensorConfig[] = [
  // v0.40.0 — no device_class: 'connectivity' here. That class means ON=connected, which
  // INVERTS this sensor's meaning (off_grid=true → ON would read as "connected"). A plain
  // binary sensor keeps ON=off-grid unambiguous; the tower-off icon conveys state.
  { unique_id: 'ecoflow_off_grid', name: 'Off-Grid', icon: 'mdi:transmission-tower-off', value_template: '{{ "ON" if value_json.off_grid else "OFF" }}' },
  // v0.89.0 — the SHP2's OWN direct grid-line flag (pd303_mc.masterIncreInfo.gridSta=Grid OK,
  // online-gated). ON=grid connected. Unlike off_grid (which can flip during the SHP2's
  // between-burst gaps when measured flow momentarily reads 0), this stays ON through the
  // gaps and drops the instant the utility is lost. `unknown` (no template value) when the
  // SHP2 is cloud-offline or the field is absent — do NOT infer a grid state from unknown.
  { unique_id: 'ecoflow_shp2_grid_connected', name: 'SHP2 Grid Connected', icon: 'mdi:transmission-tower', value_template: '{{ value_json.shp2_grid_connected }}' },
  // v0.59.0 — ON when the runway / projected-low-SoC numbers only apply to the
  // ISLANDED case (the grid is actively backstopping the load now). Gate HA
  // "runway < threshold" automations on this so a 0% / low-hour projection during
  // a grid-tied cycle isn't treated as an imminent-depletion emergency.
  { unique_id: 'ecoflow_runway_projection_islanded_only', name: 'Runway Projection Islanded-Only', icon: 'mdi:transmission-tower-import', value_template: '{{ "ON" if value_json.runway_projection_islanded_only else "OFF" }}' },
  // v0.69.0 — companion to the runway flag, scoped to the Projected Low SoC sensor:
  // ON when that 0%/low projection only applies to the islanded case (grid backstopping
  // now). Gate HA `projected_low_soc < N` automations on this to drop grid-tied false alarms.
  { unique_id: 'ecoflow_projected_low_soc_islanded_only', name: 'Projected Low SoC Islanded-Only', icon: 'mdi:battery-alert-variant-outline', value_template: '{{ "ON" if value_json.projected_low_soc_islanded_only else "OFF" }}' },
  // v0.9.77 — fires when the system is actively curtailing PV (batteries
  // full + home load < expected PV). HA can trigger automations off this
  // — e.g. "if curtailing for 10 min then turn pool pump on full speed."
  // v1.3.1 (audit rank 44) — no device_class. On a BINARY sensor, HA's `power` class means
  // "ON = power detected / OFF = no power", which is not what an advisory flag says: ON here
  // means "we are curtailing", not "power is present". It also relabels the state text. The
  // sibling advisory flags above (islanded-only) correctly carry no device_class; the icon
  // conveys meaning. Same for load-shed below.
  { unique_id: 'ecoflow_pv_curtailment_active', name: 'PV Curtailment Active', icon: 'mdi:solar-power-variant', value_template: '{{ "ON" if value_json.pv_curtailment_active else "OFF" }}' },
  // v0.15.2 — ON when the load-shed advisor recommends shedding ≥1 load to
  // extend runway. The operator's HA automations actuate off this (advisory
  // model); the add-on never toggles a load itself.
  { unique_id: 'ecoflow_load_shed_recommended', name: 'Load Shed Recommended', icon: 'mdi:power-plug-off', value_template: '{{ "ON" if value_json.load_shed_recommended else "OFF" }}' },
  // ─── v1.38.0 night-charge advisory (ADVISORY / no-write) ────────────────────
  // ON when tonight's advisor recommends a cheap-overnight grid buy. CLONE of
  // ecoflow_load_shed_recommended: NO device_class (ON here means "charge is
  // recommended", not "power detected" — the class would relabel + invert the
  // meaning), the icon conveys state. The owner's HA automation actuates — the
  // add-on NEVER charges, and the automation MUST also gate on
  // night_charge_write_ready + the window_start/_end sensors, never on this alone.
  // Long expire_after (I12) so a dead advisor's retained ON is marked UNAVAILABLE,
  // never trusted as a live ON.
  { unique_id: 'ecoflow_night_charge_recommended', name: 'Night-Charge Recommended', icon: 'mdi:transmission-tower-import', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ "ON" if value_json.charge_tonight else "OFF" }}' },
  // Write-readiness gate (§5). FAIL-CLOSED: nightChargeGateFields emits this
  // strictly false on a null readiness (never null-as-true) and always emits the
  // key, so a data gap reads OFF, not a stale retained ON. NO device_class.
  { unique_id: 'ecoflow_night_charge_write_ready', name: 'Night-Charge Write Ready', icon: 'mdi:shield-check-outline', entity_category: 'diagnostic', expire_after: NIGHT_CHARGE_EXPIRE_AFTER_S, value_template: '{{ "ON" if value_json.night_charge_write_ready else "OFF" }}' },
  // v0.69.0 — ON when a SHP2-wired home core's own telemetry is missing from the
  // self-consumption integral (cloud-offline / projection-less), so solar_fraction /
  // direct-use undercount. Diagnostic: discount those KPIs while this reads ON.
  { unique_id: 'ecoflow_self_consumption_coverage_partial', name: 'Self-Consumption Coverage Partial', icon: 'mdi:gauge-low', entity_category: 'diagnostic', value_template: '{{ "ON" if value_json.self_consumption_coverage_partial else "OFF" }}' },
  // v0.77.0 — forecast built on an incomplete basis (cold history / no SoC basis while the SHP2 or home Cores are cloud-offline).
  // No device_class (matches the coverage_partial sibling): a plain diagnostic on/off, not a HA "problem" indicator that would sit
  // persistently red during a Core cloud-wedge. The point is operator-visibility of a degraded forecast basis, not an alarm.
  { unique_id: 'ecoflow_forecast_basis_incomplete', name: 'Forecast Basis Incomplete', icon: 'mdi:cloud-question', entity_category: 'diagnostic', value_template: '{{ "ON" if value_json.forecast_structurally_incomplete else "OFF" }}' },
];

/**
 * Legacy unique_id scheme cleanup (MQTT_DISCOVERY_DEDUP_VERSION = 1).
 *
 * Background: an earlier version of this file double-prefixed unique_ids
 * with the device identifier (`ecoflow_panel_ecoflow_*`). When the
 * current scheme (`ecoflow_*`, no double prefix) shipped, HA kept the
 * old entities live because nothing told it the old `unique_id`s were
 * gone — discovery is keyed on `unique_id`, so a new unique_id reads as
 * a new entity, not a rename. Result: HA's registry holds BOTH flavors
 * of every sensor (61 entities, ~half duplicates), with the orphans
 * still updating from the same retained `state` topic.
 *
 * Fix: on startup, publish an empty payload to every legacy discovery
 * topic with retain=true. HA treats an empty retained config as
 * "entity removed" and cleans the registry on next restart. Gated by a
 * marker file so the pass only runs once per install.
 *
 * If a future scheme change happens, bump `MQTT_DISCOVERY_DEDUP_VERSION`
 * and add the new round of legacy IDs to `legacyUniqueIdsFor`.
 */
export const MQTT_DISCOVERY_DEDUP_VERSION = 1;
const DEDUP_FLAG_BASENAME = `mqtt-discovery-dedup-v${MQTT_DISCOVERY_DEDUP_VERSION}.flag`;

/**
 * Return every legacy `unique_id` that maps to the current `unique_id`.
 *
 * Today: the only legacy form is the old `ecoflow_panel_<current_uid>`
 * double-prefix scheme — HA inherits `device.identifiers[0]` as a
 * unique_id prefix when the discovery payload sets `has_entity_name`
 * (or, in older releases, unconditionally). Since
 * `ecoflow_panel_<current>` can never equal `<current>` (string length
 * strictly grows), this is always safe to clear without risking the
 * live entity.
 */
export function legacyUniqueIdsFor(currentUniqueId: string): string[] {
  return [`ecoflow_panel_${currentUniqueId}`];
}

export interface CircuitDiscoveryPlan {
  /** Change-latch key: identical circuit set (channel + name) → identical sig. */
  sig: string;
  /** Per-circuit discovery configs to (re)publish. */
  publish: { topic: string; cfg: Record<string, unknown> }[];
  /** Retained config topics to clear for circuits that have disappeared. */
  clear: string[];
}

/**
 * v0.15.1 — Pure planning for per-SHP2-circuit Energy-Dashboard discovery.
 * Extracted from the runtime closure so the publish/skip/clear decision — the
 * part the original one-shot-connect path got wrong (it computed the circuit
 * list once, at broker-connect, before the first poll had populated it, and
 * never retried) — is unit-testable without a live MQTT client or store.
 *
 * Given the channels we last published and the current circuit list, returns a
 * signature (compare against the last one to decide whether anything changed),
 * the configs to (re)publish, and the config topics to clear for circuits that
 * are no longer present.
 */
/**
 * v1.65.0 — Friendly name for one circuit's Energy sensor.
 *
 * The SHP2 stores a split-phase pair's user-set name on the PRIMARY (lower)
 * channel only; the secondary's `chName` stays at the factory "Circuit N".
 * Naming each leg from its own channel therefore published half the Energy
 * Dashboard as "EcoFlow Circuit 3 Energy" — an entity the operator cannot map
 * back to anything. Both legs are real, separately-metered conductors, so we
 * keep two entities (merging would orphan six sensors' recorded statistics)
 * and instead label them from the pair: "East Wing L1" / "East Wing L2".
 *
 * SAFE TO CHANGE: HA's `unique_id` is keyed to the CHANNEL, and `entity_id` is
 * minted once at first discovery and persisted against that unique_id. Editing
 * the discovery `name` moves the friendly name only — entity_id, Energy
 * Dashboard config and long-term statistics all survive.
 */
function circuitDisplayName(
  c: { ch: number; name?: string | null; linkCh?: number | null; linkMark?: boolean },
  byCh: Map<number, { ch: number; name?: string | null }>,
): string {
  if (c.linkCh == null || !c.linkMark) return c.name || `Circuit ${c.ch}`;
  const primaryCh = Math.min(c.ch, c.linkCh);
  const base = byCh.get(primaryCh)?.name || `Circuit ${primaryCh}`;
  return `${base} ${c.ch === primaryCh ? 'L1' : 'L2'}`;
}

export function planCircuitDiscovery(
  prefix: string,
  prevChannels: number[],
  circuits: { ch: number; name?: string | null; linkCh?: number | null; linkMark?: boolean }[],
): CircuitDiscoveryPlan {
  const byCh = new Map(circuits.map((c) => [c.ch, c]));
  const display = new Map(circuits.map((c) => [c.ch, circuitDisplayName(c, byCh)]));
  // `entityName` is the string actually published, and the latch signature is
  // built from THAT — not from the raw channel name, and not from the derived
  // display name either.
  //
  // Raw is wrong because a secondary leg's `chName` never changes ("Circuit 3"
  // forever), so a rename of the primary would never reach HA. Derived is also
  // wrong, and did bite: v1.128.0 dropped a redundant "EcoFlow " from the
  // TEMPLATE around the display name. The display name was untouched, so the
  // signature was identical, so the caller skipped republishing and the twelve
  // circuit sensors kept their old doubled names in HA while every other entity
  // was renamed.
  //
  // Signing the published string closes the whole class: any change to what is
  // published — the template, a suffix, the display name — necessarily changes
  // the signature.
  const entityName = new Map(circuits.map((c) => [c.ch, `${display.get(c.ch)} Energy`]));
  // v1.141.0 — the POWER complement, for HA's Now-tab Power Sankey.
  //
  // TWELVE, not six. The "primaries only" idea comes from a NAMING problem that
  // v1.65.0 already solved by labelling legs "X L1"/"X L2" while deliberately
  // keeping twelve entities — and it does not transfer here, because `stat_rate`
  // is a field ON an existing `device_consumption` entry. There are twelve
  // entries; six sensors would fill six of them and silently drop half the panel
  // from the Sankey. Putting a pair total on the primary is worse still: that
  // entity would then mean two different things, showing the pair's watts
  // against its own L1-only energy statistic.
  const powerName = new Map(circuits.map((c) => [c.ch, `${display.get(c.ch)} Power`]));
  // The signature must cover EVERY published string, not just the energy name —
  // v1.128.0 changed a template around an unchanged display name, the signature
  // did not move, and twelve entities kept their old names while 84 others were
  // renamed. Adding a second entity per channel widens that obligation.
  const sig = circuits
    .map((c) => `${c.ch}:${entityName.get(c.ch) ?? ''}:${powerName.get(c.ch) ?? ''}`)
    .join('|');
  const current = new Set(circuits.map((c) => c.ch));
  // BOTH config topics for a departed channel. Miss one and an orphaned retained
  // config sits on the broker forever with nothing left to remove it.
  const clear = prevChannels
    .filter((ch) => !current.has(ch))
    .flatMap((ch) => [
      `${prefix}/sensor/ecoflow_circuit_${ch}_lifetime_kwh/config`,
      `${prefix}/sensor/ecoflow_circuit_${ch}_watts/config`,
    ]);
  const publish = circuits.flatMap((c) => {
    const energyId = `ecoflow_circuit_${c.ch}_lifetime_kwh`;
    const powerId = `ecoflow_circuit_${c.ch}_watts`;
    return [
      {
        topic: `${prefix}/sensor/${energyId}/config`,
        cfg: {
          unique_id: energyId,
          name: entityName.get(c.ch),
          state_topic: STATE_TOPIC,
          ...AVAILABILITY_BASE,
          device_class: 'energy',
          state_class: 'total_increasing',
          unit_of_measurement: 'kWh',
          icon: 'mdi:transmission-tower',
          value_template: `{{ value_json.circuit_${c.ch}_lifetime_kwh }}`,
          device: DEVICE_INFO,
        } as Record<string, unknown>,
      },
      {
        topic: `${prefix}/sensor/${powerId}/config`,
        cfg: {
          unique_id: powerId,
          // v1.141.1 — an `object_id: ecoflow_circuit_<ch>_power` was published
          // here in v1.141.0 to pin the entity_id rename-proof. It did NOT take
          // effect: HA minted `sensor.ecoflow_panel_east_wing_l1_power` — device
          // slug plus the slugified NAME — so the key was inert and the doc
          // claim about it was false. Removed rather than left in place, since
          // config that looks load-bearing and is not is worse than none.
          //
          // The goal is met anyway, by HA itself: an entity_id is minted ONCE at
          // first discovery and persisted against the `unique_id`, so a later
          // rename moves only the friendly name. The proof is in this very
          // fleet — the energy entity_ids still read `…_circuit_3_energy` from
          // before v1.65.0's pair-aware naming, while the power entities minted
          // today read `…_east_wing_l2_power`. Same channel, same rename, one
          // entity_id frozen and one fresh.
          name: powerName.get(c.ch),
          state_topic: STATE_TOPIC,
          ...AVAILABILITY_BASE,
          device_class: 'power',
          state_class: 'measurement',
          unit_of_measurement: 'W',
          expire_after: EXPIRE_AFTER_S,
          icon: 'mdi:flash',
          value_template: `{{ value_json.circuit_${c.ch}_watts }}`,
          device: DEVICE_INFO,
        } as Record<string, unknown>,
      },
    ];
  });
  return { sig, publish, clear };
}

/**
 * v1.141.0 — per-circuit instantaneous watts for the state payload.
 *
 * Enumerated from the SAME channel set the discovery configs use, so the two
 * cannot disagree through the documented startup race (a broker connect that
 * beats the first poll once published 0 of 12 configs).
 *
 * A missing reading is `null`, NEVER 0. On a `measurement` sensor a zero is
 * compiled into HA's mean statistic as a positive claim that the circuit drew
 * nothing — indistinguishable from a genuinely idle circuit. `circuitLifetimeFields`
 * already set this precedent. A genuine measured 0 is passed through unchanged.
 */
export function circuitPowerFields(
  circuits: ReadonlyArray<{ ch: number; watts?: number | null }>,
  lifetimeKeys: Iterable<string>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const byCh = new Map(circuits.map((c) => [c.ch, c]));
  for (const ch of circuitChannels(circuits, lifetimeKeys)) {
    const w = byCh.get(ch)?.watts;
    out[`circuit_${ch}_watts`] = typeof w === 'number' && Number.isFinite(w) ? Math.round(w) : null;
  }
  return out;
}

/**
 * v0.40.2 — per-circuit lifetime-kWh state fields, enumerated from the SAME source the
 * discovery configs use (`shp2.projection.circuits`), NOT from the recorder's lifetime
 * accumulator keys. Previously the state emitted a `circuit_<ch>_lifetime_kwh` key only
 * for circuits that already had a `circuit_<ch>_wh` accumulator entry, while discovery
 * created a sensor for EVERY live circuit. A circuit that was live but whose accumulator
 * key wasn't present yet (cold start, just-added circuit, or a brief `watts==null` gap)
 * therefore had a retained HA sensor whose `value_template '{{ value_json.circuit_N_lifetime_kwh }}'`
 * referenced a key the state omitted → HA logged a "'dict object' has no attribute
 * circuit_N_lifetime_kwh" template warning on every render until they re-converged.
 *
 * Emitting a field for every live circuit keeps discovery ⟷ state consistent. The value
 * is `null` (NOT 0) when the accumulator isn't ready — HA renders that as unavailable
 * rather than a counter drop to 0, which a `total_increasing` sensor would treat as a
 * spurious reset.
 *
 * The emitted channel set is the UNION of (a) the live circuits and (b) the channels that
 * already have a persisted `circuit_<ch>_wh` accumulator. (b) matters at add-on STARTUP:
 * the MQTT connect handler publishes state before the first poll populates the snapshot
 * (so `circuits` is empty), while HA still has the prior run's RETAINED per-circuit
 * sensors. Sourcing from live circuits alone would omit their keys in that window and
 * re-trigger the warning; the persisted accumulator keys (available immediately on boot)
 * cover it until the first snapshot arrives.
 */
/**
 * v1.141.0 — the channel set, extracted so the energy and power field builders
 * enumerate from ONE source. Two independent enumerations would drift, and the
 * drift would be invisible: HA simply shows `unknown` for whichever entity the
 * other builder forgot.
 */
export function circuitChannels(
  circuits: ReadonlyArray<{ ch: number }>,
  lifetimeKeys: Iterable<string>,
): number[] {
  const channels = new Set<number>();
  for (const c of circuits) channels.add(c.ch);
  for (const k of lifetimeKeys) {
    const m = /^circuit_(\d+)_wh$/.exec(k);
    if (m) channels.add(Number(m[1]));
  }
  return [...channels].sort((a, b) => a - b);
}

export function circuitLifetimeFields(
  circuits: ReadonlyArray<{ ch: number }>,
  lifetimeKeys: Iterable<string>,
  lifetimeKwh: (k: string) => number | null,
): Record<string, number | null> {
  return Object.fromEntries(
    circuitChannels(circuits, lifetimeKeys)
      .map((ch) => [`circuit_${ch}_lifetime_kwh`, lifetimeKwh(`circuit_${ch}_wh`)]),
  );
}

export interface MqttDiscoveryHandle {
  stop: () => void;
  client: MqttClient | null;
}

export function isMqttDiscoveryEnabled(): boolean {
  return (
    (process.env.MQTT_DISCOVERY_ENABLED === '1' || process.env.MQTT_DISCOVERY_ENABLED?.toLowerCase() === 'true') &&
    !!process.env.MQTT_DISCOVERY_HOST
  );
}

export async function startMqttDiscovery(
  store: SnapshotStore,
  recorder: Recorder,
  log: (m: string) => void,
): Promise<MqttDiscoveryHandle> {
  if (!isMqttDiscoveryEnabled()) {
    log('mqtt-discovery: disabled (set MQTT_DISCOVERY_ENABLED=1 and MQTT_DISCOVERY_HOST to publish to HA)');
    return { stop: () => {}, client: null };
  }
  const host = process.env.MQTT_DISCOVERY_HOST!;
  const port = Number(process.env.MQTT_DISCOVERY_PORT ?? 1883);
  const user = process.env.MQTT_DISCOVERY_USER;
  const pass = process.env.MQTT_DISCOVERY_PASS;
  const prefix = process.env.MQTT_DISCOVERY_PREFIX ?? 'homeassistant';
  const url = `mqtt://${host}:${port}`;
  const client = mqtt.connect(url, {
    username: user,
    password: pass,
    clientId: `ecoflow-panel-discovery-${Math.random().toString(36).slice(2, 8)}`,
    // v1.148.0 — 30_000 → 5_000, matching the sibling EcoFlow client.
    // MEASURED: when the Mosquitto add-on auto-updated 7.1.0 → 7.1.1, all 115
    // published entities went unavailable for 30.03 s while a non-ecoflow MQTT
    // client on the same broker recovered in 10.14 s. The extra 19.9 s was this
    // knob. auto_update is on, so this recurs on every broker release.
    reconnectPeriod: 5_000,
    // v0.9.69 — explicitly request MQTT v5 (the npm `mqtt` library defaults
    // to v3.1.1 when this is unset). HA Core 2026.x deprecates v3.1.1 to
    // the broker and will remove support in 2027.1.0. Setting v5 here aligns
    // every MQTT client in this codebase on one protocol and removes the
    // "broker happens to bridge both" backward-compat dependency. v5 is
    // wire-compatible with all of our usage (basic auth, will, retained
    // QoS 0 publishes) so this is a drop-in change.
    protocolVersion: 5,
    will: { topic: AVAILABILITY_TOPIC, payload: 'offline', retain: true, qos: 0 },
  });

  const connectLatch: ConnectLatch = { legacyCleared: false };
  let timer: NodeJS.Timeout | null = null;

  // One-time cleanup: clear retained discovery configs for legacy unique_ids
  // left in HA by previous releases (see `legacyUniqueIdsFor` comment).
  const dedupFlagPath = resolve(process.env.DATA_DIR ?? '/data', DEDUP_FLAG_BASENAME);
  const clearLegacyDiscovery = () => {
    // TOCTOU hardening (CodeQL js/file-system-race): probe the marker by
    // READING it — an exists→write pair on the same path is the flagged
    // check/use race. A successful read = already cleaned up; a failed read
    // (ENOENT) = run the (idempotent) cleanup, same as the old existsSync.
    try { readFileSync(dedupFlagPath); return; } catch { /* absent → run cleanup */ }
    let cleared = 0;
    const clearTopic = (topic: string) => {
      // Empty retained payload tells HA "this discovery is gone" — the
      // entity gets removed from the registry on the next HA restart.
      client.publish(topic, '', { retain: true, qos: 0 });
      cleared += 1;
    };
    for (const s of SENSORS) {
      for (const legacy of legacyUniqueIdsFor(s.unique_id)) {
        clearTopic(`${prefix}/sensor/${legacy}/config`);
      }
    }
    for (const s of BINARY_SENSORS) {
      for (const legacy of legacyUniqueIdsFor(s.unique_id)) {
        clearTopic(`${prefix}/binary_sensor/${legacy}/config`);
      }
    }
    // Per-circuit lifetime sensors — same legacy double-prefix scheme.
    const shp2 = Object.values(store.get().devices).find((d) => d.projection?.kind === 'shp2');
    if (shp2 && shp2.projection?.kind === 'shp2') {
      for (const c of (shp2.projection as Shp2Projection).circuits ?? []) {
        for (const legacy of legacyUniqueIdsFor(`ecoflow_circuit_${c.ch}_lifetime_kwh`)) {
          clearTopic(`${prefix}/sensor/${legacy}/config`);
        }
      }
    }
    try {
      mkdirSync(dirname(dedupFlagPath), { recursive: true });
      // `wx` — exclusive create; EEXIST means a racing startup already wrote
      // the marker, which is success (the retained-clear is idempotent).
      writeFileSync(dedupFlagPath, `${new Date().toISOString()}\n`, { flag: 'wx' });
    } catch (e: any) {
      // Marker file write failed — log but don't fail the connection. Worst
      // case the cleanup runs again next startup (idempotent retained-clear).
      if (e?.code !== 'EEXIST') {
        log(`mqtt-discovery: dedup marker write failed (${e?.message ?? e}); cleanup may repeat`);
      }
    }
    log(`mqtt-discovery: cleared ${cleared} legacy discovery configs (v${MQTT_DISCOVERY_DEDUP_VERSION} dedup pass)`);
  };

  const publishDiscovery = () => {
    for (const s of SENSORS) {
      const topic = `${prefix}/sensor/${s.unique_id}/config`;
      const cfg = {
        ...s,
        state_topic: STATE_TOPIC,
        ...AVAILABILITY_BASE,
        // v0.13.7 — expire live measurements, but never the total_increasing
        // energy sources (would gap HA Energy history).
        // v1.38.0 — a per-sensor `expire_after` (the night-charge advisory
        // sensors, ~25 h) wins over the 120 s default; otherwise unchanged.
        ...(s.expire_after != null
          ? { expire_after: s.expire_after }
          : s.state_class !== 'total_increasing'
            ? { expire_after: EXPIRE_AFTER_S }
            : {}),
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    for (const s of BINARY_SENSORS) {
      const topic = `${prefix}/binary_sensor/${s.unique_id}/config`;
      const cfg = {
        ...s,
        state_topic: STATE_TOPIC,
        ...AVAILABILITY_BASE,
        // v0.13.7 — binary status entities are live (never total_increasing).
        // v1.38.0 — the night-charge advisory flags override with a ~25 h expiry.
        expire_after: s.expire_after ?? EXPIRE_AFTER_S,
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    // v0.8.0 — per-SHP2-circuit Energy-Dashboard sensors are published from
    // publishCircuitDiscovery(), driven by the recurring publishState() loop
    // rather than this one-shot connect path. The circuit list only exists once
    // the first poll populates the snapshot, which can land AFTER the broker
    // connect (a startup race) — see publishCircuitDiscovery() below.
    // v0.11.0 — per-ISA-priority alarm on/off switches. Each mirrors the
    // matching `priorityEnabled[p]` flag in alertSettings. optimistic=false so
    // HA reflects the actual reported state_topic value (the server is the
    // source of truth), and we attach the shared device block so the switches
    // group under the same "EcoFlow Panel" device as every other entity.
    for (const p of ALARM_PRIORITY_ORDER) {
      const meta = ALARM_PRIORITY_META[p];
      const uniqueId = alertSwitchUniqueId(p);
      const topic = `${prefix}/switch/${uniqueId}/config`;
      const cfg = {
        unique_id: uniqueId,
        // v0.11.1 — explicit object_id → a clean entity_id
        // (switch.ecoflow_alarms_critical_p1) instead of HA deriving a verbose
        // one from the name. The name drops the redundant "EcoFlow" prefix:
        // HA prepends the device name ("EcoFlow Panel"), so the friendly name
        // reads "EcoFlow Panel Alarms — Critical (P1)" — not doubled.
        object_id: `ecoflow_alarms_${p}_${meta.isa.toLowerCase()}`,
        name: `Alarms — ${meta.label} (${meta.isa})`,
        state_topic: alertSwitchStateTopic(p),
        command_topic: alertSwitchCommandTopic(p),
        ...AVAILABILITY_BASE,
        payload_on: SWITCH_ON,
        payload_off: SWITCH_OFF,
        optimistic: false,
        icon: 'mdi:bell-ring',
        entity_category: 'config',
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    // v1.14.1 — availability 'online' moved OUT of here into the connect handler:
    // publishing it only alongside the one-time discovery configs meant a broker-
    // side disconnect (LWT retains 'offline') was never overwritten on reconnect,
    // and HA marked all entities unavailable until an add-on restart.
    log(`mqtt-discovery: published ${SENSORS.length} sensor configs + ${BINARY_SENSORS.length} binary_sensor configs + ${ALARM_PRIORITY_ORDER.length} alarm-priority switches to ${url} (prefix=${prefix})`);
  };

  // v0.11.0 — publish the current on/off state for every priority switch.
  // Retained so HA shows the right toggle position immediately on (re)connect.
  // Guarded on connection so a publish during a disconnect is a no-op.
  const publishSwitchStates = () => {
    if (!client.connected) return;
    const settings = getAlertSettings();
    for (const p of ALARM_PRIORITY_ORDER) {
      const on = settings.priorityEnabled[p] !== false;
      client.publish(alertSwitchStateTopic(p), on ? SWITCH_ON : SWITCH_OFF, { retain: true, qos: 0 });
    }
  };

  const buildState = async (snap: FleetSnapshot): Promise<Record<string, unknown>> => {
    const devices = Object.values(snap.devices);
    type Shp2Dev = typeof devices[number] & { projection: Shp2Projection };
    const shp2 = (devices as Shp2Dev[]).find((d) => d.projection?.kind === 'shp2');

    // v0.9.74 — match /api/ha-state: spare cores (not in SHP2 sources)
    // can't deliver energy to the home, so they don't count toward
    // fleet PV / total-in / total-out / battery-net or grid-import.
    // v0.52.0 — the loop that derived these is now aggregateFleetFlow, shared
    // VERBATIM with /api/ha-state (raw sums; each surface rounds at emission).
    const { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad } = aggregateFleetFlow(snap.devices);

    const analytics = getAnalytics();
    const [fc, deg, runway, rte, clipping, sc, carbon, tariff, curtailment] = await Promise.all([
      analytics.report('forecast'),
      analytics.report('degradation'),
      analytics.report('runway'),
      analytics.report('roundTripEfficiency'),
      analytics.report('clipping'),
      analytics.report('selfConsumption'),
      analytics.report('carbon'),
      analytics.report('tariff'),
      // v0.15.3 — the curtailment report was never fetched here, so the five
      // pv_curtailment_* sensors (added v0.9.77) referenced value_json keys that
      // buildState never emitted → permanent "unknown" + a template warning every
      // publish. Wiring it lights them up (and gives HA automations a real
      // pv_curtailment_active signal for opportunistic/deferrable loads).
      analytics.report('curtailment'),
    ]);
    const lifetime = recorder.getLifetimeTotals();
    const lifetimeKwh = makeLifetimeKwh(lifetime);
    const { projecting, soonest } = soonestProjecting((deg as import('./analytics.js').FleetDegradation).packs);

    const alerts = snap.alerts ?? [];
    const cnt = makeAlertCounter(alerts);
    // v0.11.0 — per-ISA-priority counts via priorityOf (severity+source → P1..P4).
    const priorityCount = (p: AlarmPriority) => alerts.filter((a) => priorityOf(a) === p).length;
    // v0.15.19 — lighting posture: the runway model's forward question ("will
    // we reach sunrise above reserve?") distilled into one enum that HA
    // automations key on (heartbeat pulse, dimmer ceilings, exterior policy).
    // Escalations apply immediately; de-escalations hold 15 min (hysteresis
    // lives in the shared tracker).
    const posture = lightingPostureTracker.update({
      belowReserveFloor: belowReserveFloor(runway as Parameters<typeof belowReserveFloor>[0]),
      hoursToReserve: (runway as { hoursToReserve: number | null }).hoursToReserve,
      dawnMinSocPct: fc.minProjectedSoc,
      reservePct: shp2?.projection.backupReserveSoc ?? null,
      curtailmentActive: !!(curtailment as { active?: boolean }).active,
      // v0.87.0 — feed the same grid-backstop signal the alarm engines use so the
      // posture stops escalating to red/amber on a grid-tied evening (the runway
      // projection it keys on is islanded-only). Same resolver as off_grid /
      // runway_projection_islanded_only above.
      gridBackstopping: liveGridBackstop(snap.devices).backstopping,
      nowMs: Date.now(),
    });
    return {
      lighting_posture: posture.posture,
      lighting_posture_reason: posture.reason,
      fleet_pv_watts: Math.round(fleetPv),
      panel_load_watts: Math.round(panelLoad),
      ac_import_watts: Math.round(acIn),
      fleet_battery_net_watts: Math.round(fleetBatteryNet),
      // v0.48.0 — whole-home grid POWER at the SHP2 main (wattInfo.gridWatt), the
      // power complement of the grid_to_home lifetime energy sensor. Null-safe: the
      // sensor reads HA 'unknown' when the SHP2 projection has no gridWatt yet.
      grid_home_watts: shp2?.projection.gridWatt != null ? Math.round(shp2.projection.gridWatt) : null,
      // v0.40.0 — resolve off-grid via the grid-presence resolver (GRID_PRESENCE_ENTITY +
      // SHP2 gridWatt + DPU ac_in), NOT `acIn < 5`. On a PV/battery-covered home DPU ac_in
      // is structurally ~0, so the old test pinned this sensor to off-grid 24/7 even while
      // the operator's grid toggle was ON and the SHP2 backstopped the home from grid. This
      // now matches the alarm engine's view (which kept critical=0 through the floor drain).
      off_grid: !liveGridBackstop(snap.devices).present,
      // v0.89.0 — the SHP2's OWN grid-line flag, online-gated (gridState.shp2GridConnected).
      // ON/OFF/unknown (null) — the burst-gap-immune complement to off_grid.
      shp2_grid_connected: (() => {
        const c = liveGridBackstop(snap.devices).shp2GridConnected;
        return c == null ? null : c ? 'ON' : 'OFF';
      })(),
      // v0.89.0 — human-readable raw gridSta for the diagnostic sensor.
      shp2_grid_status: (() => {
        const s = shp2?.projection.gridSta ?? null;
        return s == null ? null : s === 1 ? 'Grid OK' : s === 0 ? 'Grid not detected' : s === 2 ? 'Grid overvolt/overfreq' : `code ${s}`;
      })(),
      backup_pool_percent: shp2?.projection.backupBatPercent ?? null,
      backup_remaining_kwh: kwh1(shp2?.projection.backupRemainWh),
      backup_full_capacity_kwh: kwh1(shp2?.projection.backupFullCapWh),
      // v0.78.0 — RESTORED display basis, byte-identical to /api/ha-state (see index.ts).
      forecast_pv_next_24h_kwh: Math.round((fc.forecastPvWhNext24Display ?? fc.forecastPvWhNext24) / 100) / 10,
      projected_low_soc_percent: fc.minProjectedSoc,
      forecast_structurally_incomplete: fc.structurallyIncomplete ?? false, // v0.77.0 — diagnostic basis flag
      soiling_drop_percent: fc.soiling?.dropPct ?? null,
      degradation_soonest_eol_years: soonest?.yearsToEol ?? null,
      degradation_peer_outliers: projecting.filter((p) => p.peerOutlier).length,
      // v0.15.11 — sentinel (not bare null) when net-charging, so the MQTT
      // sensors don't read HA 'unknown' (which must mean data-loss only).
      runway_to_reserve_hours: runwayHoursForPublish(runway.hoursToReserve, runway.unavailable),
      runway_to_empty_hours: runwayHoursForPublish(runway.hoursToEmpty, runway.unavailable),
      // v0.59.0 — runway/dip projections assume islanded; true when the grid is
      // actively backstopping → a low reading is informational, not actionable.
      runway_projection_islanded_only: liveGridBackstop(snap.devices).backstopping,
      projected_low_soc_islanded_only: liveGridBackstop(snap.devices).backstopping,
      round_trip_efficiency_percent: rte.efficiencyPct,
      pv_clipped_kwh_today: clipping.todayKwh,
      pv_array_peak_watts: clipping.arrayPeakW,
      // v0.15.3 — curtailment (batteries full → PV throttled). Previously absent.
      pv_curtailment_active: !!curtailment.active,
      pv_curtailment_surplus_watts: Math.round(curtailment.currentSurplusW ?? 0),
      pv_curtailment_kwh_today: curtailment.todayKwh ?? null,
      pv_curtailment_kwh_7d: curtailment.recent7dKwh ?? null,
      pv_curtailment_charge_ceiling_pct: curtailment.current?.chargeCeilingPct ?? null,
      solar_fraction_of_load_percent: sc.solarFractionOfLoadPct,
      direct_use_ratio_percent: sc.directUseRatioPct,
      self_consumption_coverage_partial: sc.homeDpusCoveragePartial,
      pv_lifetime_kwh: lifetimeKwh('fleet_pv_wh'),
      load_lifetime_kwh: lifetimeKwh('fleet_load_wh'),
      grid_import_lifetime_kwh: lifetimeKwh('fleet_grid_import_wh'),
      grid_to_home_lifetime_kwh: lifetimeKwh('fleet_grid_home_wh'),
      battery_charge_lifetime_kwh: lifetimeKwh('fleet_battery_charge_wh'),
      battery_discharge_lifetime_kwh: lifetimeKwh('fleet_battery_discharge_wh'),
      // v0.8.0 — per-circuit lifetime + carbon + tariff
      // v0.40.2/.3 — enumerate per-circuit lifetime keys from the UNION of the live circuit
      // list (same source as discovery) and the PERSISTED lifetime keys (recorder.listLifetimeKeys
      // reads the lifetime_totals table directly — NOT getLifetimeTotals(), whose key set is
      // snapshot-gated and so has no per-circuit keys until the first poll). This makes every
      // discovered per-circuit sensor find its key — in steady state AND at startup before the
      // snapshot loads, matching the prior run's retained sensors (fixes the recurring
      // "circuit_N_lifetime_kwh" HA template warning, incl. the startup race Copilot flagged).
      ...circuitLifetimeFields(shp2 ? shp2.projection.circuits : [], recorder.listLifetimeKeys(), lifetimeKwh),
      ...circuitPowerFields(shp2 ? shp2.projection.circuits : [], recorder.listLifetimeKeys()),
      carbon_kg_avoided_7d: carbon.totalKgAvoided,
      carbon_lifetime_kg_avoided: carbon.lifetimeKgAvoided,
      carbon_lifetime_miles_not_driven: carbon.lifetimeMilesNotDriven,
      tariff_today_grid_cost_dollars: tariff.todayGridImportCostDollars,
      tariff_today_solar_value_dollars: tariff.todaySolarLoadValueDollars,
      tariff_net_savings_7d_dollars: tariff.netSavingsDollars,
      // v1.134.0 — dollars per kWh, in force right now. NULL (never a fallback
      // rate) when the tariff is unconfirmed or the matched period has no season
      // rate: a silent off-peak default would reintroduce exactly the mispricing
      // this entity exists to remove, and HA correctly declines to accrue cost
      // from an unavailable price rather than accruing a wrong one.
      tariff_rate_now_usd_per_kwh: (() => {
        const cents = rateAt(apsREvModelFromEnv(), Date.now()).centsPerKwh;
        return cents == null ? null : Math.round((cents / 100) * 1e4) / 1e4;
      })(),
      alert_critical_count: cnt('threshold', 'critical'),
      alert_warning_count: cnt('threshold', 'warning'),
      learned_warning_count: cnt('learned', 'warning'),
      // v0.11.0 — additive per-priority alarm counts (P1 Critical … P4 Low).
      alert_high_count: priorityCount('high'),
      alert_medium_count: priorityCount('medium'),
      alert_low_count: priorityCount('low'),
      fleet_devices_online: devices.filter((d) => d.online).length,
      // Cloud-wedge diagnostic — devices cloud-offline but LAN-reachable per the
      // configured HA ping binary_sensors. 0 when ECOFLOW_DEVICE_REACHABILITY is
      // unset (every offline device classifies 'unknown', never 'cloud_wedge').
      ecoflow_cloud_wedge_count: countCloudWedges(devices),
      // 'ok' or the reason the alarm path could not be observed this poll.
      poll_health: (() => { const h = pollHealth(); return h.ok ? 'ok' : h.reason ?? 'not-ok'; })(),
      // v1.148.0 — this feeds the PUBLISHED sensor, so it is the singleton path
      // that matters most; `shp2` here comes from the same raw scan the rest of
      // buildState uses. Left as-is deliberately rather than diverging from its
      // neighbours mid-function — the whole block wants one pass through
      // findShp2()/shp2Panels(). Flagged, not half-fixed.
      shp2_content_frozen_s: shp2?.contentStaleSinceMs != null
        ? Math.round((Date.now() - shp2.contentStaleSinceMs) / 1000)
        : 0,
      // v0.83.0 — system data-gap / unplanned-outage tracking (24 h). Mirrors the
      // /api/ha-state tiles so the MQTT diagnostic sensors have data.
      // v1.14.0 — single-sourced with /api/ha-state (alerts.ts systemOutageFields).
      ...systemOutageFields(recorder.telemetryGaps(), Date.now()),
      // v0.84.0 — audible-delivery health mirror (see broadcastHealth.ts). Status
      // is 4-state so `disabled`/`unknown` never read as a false "unreachable".
      ...(() => {
        const h = getBroadcastHealth();
        const status = !h.enabled
          ? 'disabled'
          : h.reachable === true
            ? 'reachable'
            : h.reachable === false
              ? 'UNREACHABLE'
              : 'unknown';
        return {
          audible_status: status,
          audible_usable_speakers: h.usableTargets,
        };
      })(),
      // v0.15.2 — load-shed advisory signals (recommendation + counterfactual)
      // for HA automations to gate on. Latest is computed on the advisor tick.
      ...advisoryStateFields(getLatestAdvisory()),
      // v1.38.0 — night-charge advisory (state fields) + write-readiness gate
      // fields (design §4.1). Both are fail-safe: nightChargeStateFields returns
      // charge_tonight strictly false and numeric fields null unless the plan is
      // fresh (basisComplete && <12 h old); nightChargeGateFields returns
      // night_charge_write_ready strictly false on a null readiness. Wired here
      // AND into /api/ha-state (index.ts) in parity, matching the pv_curtailment
      // precedent. Read-only — no field here is consumed by the alarm spine.
      host_soc_temp_c: liveHostTemp()?.tempC ?? null,
      host_evloop_lag_ms: liveVitals()?.evLoopLagMs ?? null,
      host_mem_available_mb: liveVitals()?.memAvailableMb ?? null,
      host_data_disk_free_mb: liveVitals()?.dataDiskFreeMb ?? null,
      host_load_1m: liveVitals()?.load1 ?? null,
      ...nightChargeStateFields(getLatestNightChargePlan()),
      ...nightChargeGateFields(getLatestReadiness()),
      // v0.89.0 — SHP2 operating-mode / reserve strategy diagnostics. Reserve floor
      // reads the CANONICAL projection.backupReserveSoc the floor alarm defends with
      // (NOT strategy.backupReserveSoc). Mode codes are raw SHP2 enum ints (no
      // published semantics). Null-safe → HA 'unknown' when cloud-offline.
      ...(() => {
        const st = shp2?.projection.strategy;
        return {
          backup_reserve_percent: shp2?.projection.backupReserveSoc ?? null,
          solar_backup_reserve_percent: st?.solarBackupReserveSoc ?? null,
          // v1.3.0 — null (not false) when the strategy is unavailable; see the sensor's template.
          backup_reserve_enabled: st?.backupReserveEnabled ?? null,
          smart_backup_mode_code: st?.smartBackupMode ?? null,
          backup_mode_code: st?.backupMode ?? null,
          overload_mode_code: st?.overloadMode ?? null,
        };
      })(),
    };
  };

  // v0.15.1 — Per-SHP2-circuit discovery, decoupled from the one-shot connect.
  // The circuit list only exists once the first REST poll populates the snapshot,
  // which can race AFTER the broker `connect` fires (observed: a boot where the
  // connect beat the first poll published 0 of 12 per-circuit configs). Driving
  // this from the recurring publishState() loop guarantees the configs are
  // asserted as soon as the SHP2 projection appears, re-asserted if the circuit
  // set changes, and orphaned configs for removed circuits are cleared. The
  // `sig` latch makes every steady-state tick a no-op (no churn, no log spam).
  let circuitDiscoverySig: string | null = null;
  let publishedCircuitChannels: number[] = [];
  const publishCircuitDiscovery = () => {
    if (!client.connected) return;
    const shp2 = Object.values(store.get().devices).find((d) => d.projection?.kind === 'shp2');
    if (!shp2 || shp2.projection?.kind !== 'shp2') return; // no projection yet — retry next tick
    const circuits = (shp2.projection as Shp2Projection).circuits ?? [];
    const plan = planCircuitDiscovery(prefix, publishedCircuitChannels, circuits);
    if (plan.sig === circuitDiscoverySig) return; // this exact circuit set already asserted
    for (const topic of plan.clear) client.publish(topic, '', { retain: true, qos: 0 });
    for (const { topic, cfg } of plan.publish) {
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    circuitDiscoverySig = plan.sig;
    publishedCircuitChannels = circuits.map((c) => c.ch);
    log(`mqtt-discovery: published ${plan.publish.length} per-circuit sensor configs (energy + power)`);
  };

  const publishState = async () => {
    if (!client.connected) return;
    // v1.14.1 belt-and-braces — re-assert availability every state cycle while
    // connected, so no future path can leave a retained 'offline' standing while
    // we are demonstrably alive and publishing (tiny retained payload, idempotent).
    client.publish(AVAILABILITY_TOPIC, 'online', { retain: true, qos: 0 });
    // Assert/refresh the dynamic per-circuit discovery configs before the state
    // payload, so HA has the entity definitions in hand when the values land.
    publishCircuitDiscovery();
    try {
      const state = await buildState(store.get());
      client.publish(STATE_TOPIC, JSON.stringify(state), { retain: true, qos: 0 });
    } catch (e: any) {
      log(`mqtt-discovery: state publish failed — ${e?.message ?? e}`);
    }
  };

  // v0.11.0 — HA toggled a switch: apply it to alertSettings (source 'mqtt'),
  // then echo the resolved state back to that switch's STATE topic. We publish
  // to the STATE topic (not the COMMAND topic) so this never re-triggers the
  // command handler — no feedback loop. Topic→priority + ON/OFF parsing is the
  // pure parseAlertSwitchCommand helper above (v0.76.0); any non-command topic
  // or unknown payload returns null and is a no-op here.
  const handleSwitchCommand = (topic: string, payloadRaw: string) => {
    const cmd = parseAlertSwitchCommand(topic, payloadRaw);
    if (!cmd) return;
    const { priority: p, enabled } = cmd;
    // updateAlertSettings notifies onAlertSettingsChange listeners (incl. the
    // one below) which republishes ALL switch states — but publishing to the
    // retained STATE topic here too keeps this priority's toggle snappy.
    updateAlertSettings({ priorityEnabled: { [p]: enabled } }, 'mqtt');
    if (client.connected) {
      client.publish(alertSwitchStateTopic(p), enabled ? SWITCH_ON : SWITCH_OFF, { retain: true, qos: 0 });
    }
  };

  client.on('message', (topic, payload) => {
    try {
      handleSwitchCommand(topic, payload.toString());
    } catch (e: any) {
      log(`mqtt-discovery: switch command handling failed — ${e?.message ?? e}`);
    }
  });

  // v0.11.0 — keep HA switches in lockstep when the change originates elsewhere
  // (e.g. the web "Alert Settings" page). Republish every switch state on any
  // settings change. The 'mqtt'-sourced change above also lands here, but
  // re-publishing the same retained STATE value is harmless and idempotent.
  const unsubscribeSettings = onAlertSettingsChange(() => publishSwitchStates());

  client.on('connect', () => {
    log(`mqtt-discovery: connected to ${url}`);
    // v1.137.0 — the whole connect sequence, and which parts of it are latched,
    // now live in runBrokerConnect. See its comment for why discovery re-asserts
    // on every connect while the legacy clear and the circuit ledger do not.
    runBrokerConnect(connectLatch, {
      publishAvailability: () => client.publish(AVAILABILITY_TOPIC, 'online', { retain: true, qos: 0 }),
      clearLegacyDiscovery,
      publishDiscovery,
      invalidateCircuitDiscovery: () => {
        // Force the next publishCircuitDiscovery() tick to re-assert. Do NOT
        // touch publishedCircuitChannels — that is the orphan ledger, not a
        // latch.
        circuitDiscoverySig = null;
      },
      subscribeSwitchCommands: () => {
        for (const p of ALARM_PRIORITY_ORDER) {
          client.subscribe(alertSwitchCommandTopic(p), { qos: 0 }, (err) => {
            if (err) log(`mqtt-discovery: subscribe ${alertSwitchCommandTopic(p)} failed — ${err.message}`);
          });
        }
      },
      publishState,
      publishSwitchStates,
    });
  });
  client.on('error', (e) => log(`mqtt-discovery: ${e.message}`));
  client.on('reconnect', () => log('mqtt-discovery: reconnecting'));

  timer = setInterval(() => publishState(), PUBLISH_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      unsubscribeSettings();
      client.publish(AVAILABILITY_TOPIC, 'offline', { retain: true, qos: 0 });
      client.end(true);
    },
    client,
  };
}
