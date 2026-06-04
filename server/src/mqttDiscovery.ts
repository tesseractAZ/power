import mqtt, { MqttClient } from 'mqtt';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { Recorder } from './recorder.js';
import { getAnalytics } from './analyticsClient.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import { shp2ConnectedDpuSns, isShp2Connected } from './shp2Membership.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
  computeCarbonReport,
  computeTariffReport,
} from './analytics.js';
// v0.11.0 — mirror the per-ISA-priority alarm on/off toggles as HA switch
// entities and the per-priority alarm counts as sensors.
import { ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META, priorityOf, type AlarmPriority } from './alertPriority.js';
import { getAlertSettings, updateAlertSettings, onAlertSettingsChange } from './alertSettings.js';

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

const DEVICE_INFO = {
  identifiers: ['ecoflow_panel'],
  name: 'EcoFlow Panel',
  model: 'SHP2 + Delta Pro Ultra fleet dashboard',
  manufacturer: 'EcoFlow Panel (add-on)',
  sw_version: '0.8.0',
};

const STATE_TOPIC = 'ecoflow_panel/state';
const AVAILABILITY_TOPIC = 'ecoflow_panel/availability';
const PUBLISH_INTERVAL_MS = 30 * 1000;

// v0.11.0 — per-priority alarm on/off switch topics. Each ISA priority gets a
// dedicated state + command topic under the same `ecoflow_panel` base prefix
// the other entities use. The switch object/unique id is `ecoflow_alerts_<p>`.
const alertSwitchUniqueId = (p: AlarmPriority) => `ecoflow_alerts_${p}`;
const alertSwitchStateTopic = (p: AlarmPriority) => `ecoflow_panel/alerts/${p}/state`;
const alertSwitchCommandTopic = (p: AlarmPriority) => `ecoflow_panel/alerts/${p}/set`;
const SWITCH_ON = 'ON';
const SWITCH_OFF = 'OFF';

export interface SensorConfig {
  unique_id: string;
  name: string;
  device_class?: string;
  state_class?: string;
  unit_of_measurement?: string;
  icon?: string;
  value_template: string;
  entity_category?: 'diagnostic' | 'config';
}

export const SENSORS: SensorConfig[] = [
  // Power flow
  { unique_id: 'ecoflow_fleet_pv_watts', name: 'EcoFlow Fleet PV', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.fleet_pv_watts }}' },
  { unique_id: 'ecoflow_panel_load_watts', name: 'EcoFlow Panel Load', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.panel_load_watts }}' },
  { unique_id: 'ecoflow_ac_import_watts', name: 'EcoFlow AC Import', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.ac_import_watts }}' },
  { unique_id: 'ecoflow_fleet_battery_net_watts', name: 'EcoFlow Battery Net', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.fleet_battery_net_watts }}' },
  // SHP2 backup pool
  { unique_id: 'ecoflow_backup_pool', name: 'EcoFlow Backup Pool', device_class: 'battery', state_class: 'measurement', unit_of_measurement: '%', value_template: '{{ value_json.backup_pool_percent }}' },
  { unique_id: 'ecoflow_backup_remaining_kwh', name: 'EcoFlow Backup Remaining', device_class: 'energy_storage', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.backup_remaining_kwh }}' },
  { unique_id: 'ecoflow_backup_full_capacity_kwh', name: 'EcoFlow Backup Capacity', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.backup_full_capacity_kwh }}' },
  // Forecast
  { unique_id: 'ecoflow_forecast_pv_next_24h_kwh', name: 'EcoFlow Forecast PV Next 24h', device_class: 'energy', state_class: 'measurement', unit_of_measurement: 'kWh', value_template: '{{ value_json.forecast_pv_next_24h_kwh }}' },
  { unique_id: 'ecoflow_projected_low_soc', name: 'EcoFlow Projected Low SoC', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-low', value_template: '{{ value_json.projected_low_soc_percent }}' },
  { unique_id: 'ecoflow_soiling_drop_percent', name: 'EcoFlow Solar Soiling', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:weather-dust', value_template: '{{ value_json.soiling_drop_percent }}' },
  // Degradation
  { unique_id: 'ecoflow_degradation_soonest_eol_years', name: 'EcoFlow Soonest Pack EOL', state_class: 'measurement', unit_of_measurement: 'yr', icon: 'mdi:battery-clock', value_template: '{{ value_json.degradation_soonest_eol_years }}' },
  { unique_id: 'ecoflow_degradation_peer_outliers', name: 'EcoFlow Peer-Outlier Packs', state_class: 'measurement', icon: 'mdi:alert-decagram-outline', value_template: '{{ value_json.degradation_peer_outliers }}' },
  // Runway
  { unique_id: 'ecoflow_runway_to_reserve_hours', name: 'EcoFlow Runway to Reserve', state_class: 'measurement', unit_of_measurement: 'h', icon: 'mdi:timer-sand', value_template: '{{ value_json.runway_to_reserve_hours }}' },
  { unique_id: 'ecoflow_runway_to_empty_hours', name: 'EcoFlow Runway to Empty', state_class: 'measurement', unit_of_measurement: 'h', icon: 'mdi:timer-off', value_template: '{{ value_json.runway_to_empty_hours }}' },
  // RTE
  { unique_id: 'ecoflow_round_trip_efficiency', name: 'EcoFlow Round-Trip Efficiency', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-sync-outline', value_template: '{{ value_json.round_trip_efficiency_percent }}' },
  // Clipping
  { unique_id: 'ecoflow_pv_clipped_kwh_today', name: 'EcoFlow PV Clipped Today', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_clipped_kwh_today }}' },
  { unique_id: 'ecoflow_pv_array_peak_watts', name: 'EcoFlow PV Array Peak', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.pv_array_peak_watts }}', entity_category: 'diagnostic' },
  // v0.9.77 — SoC-saturation curtailment ("batteries full, panels throttled")
  { unique_id: 'ecoflow_pv_curtailment_surplus_watts', name: 'EcoFlow PV Curtailment Surplus', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', icon: 'mdi:solar-power-variant', value_template: '{{ value_json.pv_curtailment_surplus_watts }}' },
  { unique_id: 'ecoflow_pv_curtailment_kwh_today', name: 'EcoFlow PV Curtailed Today', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_today }}' },
  { unique_id: 'ecoflow_pv_curtailment_kwh_7d', name: 'EcoFlow PV Curtailed 7d', device_class: 'energy', state_class: 'measurement', unit_of_measurement: 'kWh', icon: 'mdi:solar-power-variant-outline', value_template: '{{ value_json.pv_curtailment_kwh_7d }}' },
  { unique_id: 'ecoflow_charge_ceiling', name: 'EcoFlow Charge Ceiling', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:battery-charging-100', value_template: '{{ value_json.pv_curtailment_charge_ceiling_pct }}', entity_category: 'diagnostic' },
  // Self-consumption (v0.7.5)
  { unique_id: 'ecoflow_solar_fraction_of_load', name: 'EcoFlow Solar Fraction of Load', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:solar-power', value_template: '{{ value_json.solar_fraction_of_load_percent }}' },
  { unique_id: 'ecoflow_direct_use_ratio', name: 'EcoFlow PV Direct Use Ratio', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:transmission-tower-import', value_template: '{{ value_json.direct_use_ratio_percent }}' },
  // Alert counts — these legacy entity-ids are load-bearing (HA history depends
  // on them); do NOT rename or remove.
  { unique_id: 'ecoflow_alert_critical_count', name: 'EcoFlow Critical Alerts', state_class: 'measurement', icon: 'mdi:alert-octagon', value_template: '{{ value_json.alert_critical_count }}' },
  { unique_id: 'ecoflow_alert_warning_count', name: 'EcoFlow Warning Alerts', state_class: 'measurement', icon: 'mdi:alert', value_template: '{{ value_json.alert_warning_count }}' },
  { unique_id: 'ecoflow_learned_warning_count', name: 'EcoFlow Learned Warnings', state_class: 'measurement', icon: 'mdi:lightbulb-on', value_template: '{{ value_json.learned_warning_count }}' },
  // v0.11.0 — additive per-ISA-priority alarm counts (Critical already exposed
  // above via alert_critical_count; these cover High/Medium/Low). Derived from
  // priorityOf(alert) so they track the same 4-tier taxonomy as the switches.
  { unique_id: 'ecoflow_alert_high_count', name: 'EcoFlow High Priority Alarms (P2)', state_class: 'measurement', icon: 'mdi:alert', value_template: '{{ value_json.alert_high_count }}' },
  { unique_id: 'ecoflow_alert_medium_count', name: 'EcoFlow Medium Priority Alarms (P3)', state_class: 'measurement', icon: 'mdi:alert-outline', value_template: '{{ value_json.alert_medium_count }}' },
  { unique_id: 'ecoflow_alert_low_count', name: 'EcoFlow Low Priority Alarms (P4)', state_class: 'measurement', icon: 'mdi:information-outline', value_template: '{{ value_json.alert_low_count }}' },
  // Fleet
  { unique_id: 'ecoflow_fleet_devices_online', name: 'EcoFlow Fleet Devices Online', state_class: 'measurement', icon: 'mdi:home-battery', value_template: '{{ value_json.fleet_devices_online }}' },
  // ─── HA Energy Dashboard — monotonic lifetime counters (v0.7.6) ──────────
  // state_class: total_increasing tells HA to treat decreases as resets and
  // accumulate the per-hour delta into long-term Energy statistics.
  { unique_id: 'ecoflow_pv_lifetime_kwh', name: 'EcoFlow PV Production', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:solar-power', value_template: '{{ value_json.pv_lifetime_kwh }}' },
  { unique_id: 'ecoflow_load_lifetime_kwh', name: 'EcoFlow Home Consumption', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:home-lightning-bolt', value_template: '{{ value_json.load_lifetime_kwh }}' },
  { unique_id: 'ecoflow_grid_import_lifetime_kwh', name: 'EcoFlow Grid Import', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:transmission-tower-import', value_template: '{{ value_json.grid_import_lifetime_kwh }}' },
  { unique_id: 'ecoflow_battery_charge_lifetime_kwh', name: 'EcoFlow Battery Energy In', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:battery-charging', value_template: '{{ value_json.battery_charge_lifetime_kwh }}' },
  { unique_id: 'ecoflow_battery_discharge_lifetime_kwh', name: 'EcoFlow Battery Energy Out', device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', icon: 'mdi:battery-arrow-down', value_template: '{{ value_json.battery_discharge_lifetime_kwh }}' },

  // ─── v0.8.0 sustainability + tariff ──────────────────────────────────────
  { unique_id: 'ecoflow_carbon_kg_avoided_7d', name: 'EcoFlow CO2 Avoided (7d)', state_class: 'measurement', unit_of_measurement: 'kg', icon: 'mdi:leaf', value_template: '{{ value_json.carbon_kg_avoided_7d }}' },
  { unique_id: 'ecoflow_carbon_lifetime_kg', name: 'EcoFlow CO2 Avoided Lifetime', state_class: 'total_increasing', unit_of_measurement: 'kg', icon: 'mdi:leaf', value_template: '{{ value_json.carbon_lifetime_kg_avoided }}' },
  { unique_id: 'ecoflow_carbon_lifetime_miles', name: 'EcoFlow Equivalent Miles Not Driven', state_class: 'total_increasing', unit_of_measurement: 'mi', icon: 'mdi:car-electric', value_template: '{{ value_json.carbon_lifetime_miles_not_driven }}' },
  { unique_id: 'ecoflow_tariff_today_cost', name: 'EcoFlow Grid Cost Today', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash', value_template: '{{ value_json.tariff_today_grid_cost_dollars }}' },
  { unique_id: 'ecoflow_tariff_today_saved', name: 'EcoFlow Solar Value Today', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash-plus', value_template: '{{ value_json.tariff_today_solar_value_dollars }}' },
  { unique_id: 'ecoflow_tariff_savings_7d', name: 'EcoFlow Net Savings (7d)', state_class: 'measurement', unit_of_measurement: 'USD', icon: 'mdi:cash-check', value_template: '{{ value_json.tariff_net_savings_7d_dollars }}' },
];

export const BINARY_SENSORS = [
  { unique_id: 'ecoflow_off_grid', name: 'EcoFlow Off-Grid', device_class: 'connectivity', icon: 'mdi:transmission-tower-off', value_template: '{{ "ON" if value_json.off_grid else "OFF" }}' },
  // v0.9.77 — fires when the system is actively curtailing PV (batteries
  // full + home load < expected PV). HA can trigger automations off this
  // — e.g. "if curtailing for 10 min then turn pool pump on full speed."
  { unique_id: 'ecoflow_pv_curtailment_active', name: 'EcoFlow PV Curtailment Active', device_class: 'power', icon: 'mdi:solar-power-variant', value_template: '{{ "ON" if value_json.pv_curtailment_active else "OFF" }}' },
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
    reconnectPeriod: 30_000,
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

  let published = false;
  let timer: NodeJS.Timeout | null = null;

  // One-time cleanup: clear retained discovery configs for legacy unique_ids
  // left in HA by previous releases (see `legacyUniqueIdsFor` comment).
  const dedupFlagPath = resolve(process.env.DATA_DIR ?? '/data', DEDUP_FLAG_BASENAME);
  const clearLegacyDiscovery = () => {
    if (existsSync(dedupFlagPath)) return;
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
      writeFileSync(dedupFlagPath, `${new Date().toISOString()}\n`);
    } catch (e: any) {
      // Marker file write failed — log but don't fail the connection. Worst
      // case the cleanup runs again next startup (idempotent retained-clear).
      log(`mqtt-discovery: dedup marker write failed (${e?.message ?? e}); cleanup may repeat`);
    }
    log(`mqtt-discovery: cleared ${cleared} legacy discovery configs (v${MQTT_DISCOVERY_DEDUP_VERSION} dedup pass)`);
  };

  const publishDiscovery = () => {
    for (const s of SENSORS) {
      const topic = `${prefix}/sensor/${s.unique_id}/config`;
      const cfg = {
        ...s,
        state_topic: STATE_TOPIC,
        availability_topic: AVAILABILITY_TOPIC,
        payload_available: 'online',
        payload_not_available: 'offline',
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    for (const s of BINARY_SENSORS) {
      const topic = `${prefix}/binary_sensor/${s.unique_id}/config`;
      const cfg = {
        ...s,
        state_topic: STATE_TOPIC,
        availability_topic: AVAILABILITY_TOPIC,
        payload_available: 'online',
        payload_not_available: 'offline',
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    // v0.8.0 — publish one Energy-Dashboard sensor per SHP2 circuit so each
    // appears as an "Individual device" under HA's Energy Dashboard. Built
    // dynamically from the current snapshot's circuit list (auto-adapts if
    // the user adds/removes SHP2 circuits later).
    const shp2 = Object.values(store.get().devices).find((d) => d.projection?.kind === 'shp2');
    if (shp2 && shp2.projection?.kind === 'shp2') {
      const circuits = (shp2.projection as Shp2Projection).circuits ?? [];
      for (const c of circuits) {
        const uniqueId = `ecoflow_circuit_${c.ch}_lifetime_kwh`;
        const name = `EcoFlow ${c.name || `Circuit ${c.ch}`} Energy`;
        const topic = `${prefix}/sensor/${uniqueId}/config`;
        const cfg = {
          unique_id: uniqueId,
          name,
          state_topic: STATE_TOPIC,
          availability_topic: AVAILABILITY_TOPIC,
          payload_available: 'online',
          payload_not_available: 'offline',
          device_class: 'energy',
          state_class: 'total_increasing',
          unit_of_measurement: 'kWh',
          icon: 'mdi:transmission-tower',
          value_template: `{{ value_json.circuit_${c.ch}_lifetime_kwh }}`,
          device: DEVICE_INFO,
        };
        client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
      }
      log(`mqtt-discovery: published ${circuits.length} per-circuit lifetime sensors`);
    }
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
        availability_topic: AVAILABILITY_TOPIC,
        payload_available: 'online',
        payload_not_available: 'offline',
        payload_on: SWITCH_ON,
        payload_off: SWITCH_OFF,
        optimistic: false,
        icon: 'mdi:bell-ring',
        entity_category: 'config',
        device: DEVICE_INFO,
      };
      client.publish(topic, JSON.stringify(cfg), { retain: true, qos: 0 });
    }
    client.publish(AVAILABILITY_TOPIC, 'online', { retain: true, qos: 0 });
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
    type DpuDev = typeof devices[number] & { projection: DpuProjection };
    type Shp2Dev = typeof devices[number] & { projection: Shp2Projection };
    const dpus = (devices as DpuDev[]).filter((d) => d.online && d.projection?.kind === 'dpu');
    const shp2 = (devices as Shp2Dev[]).find((d) => d.projection?.kind === 'shp2');

    // v0.9.74 — match /api/ha-state: spare cores (not in SHP2 sources)
    // can't deliver energy to the home, so they don't count toward
    // fleet PV / total-in / total-out / battery-net or grid-import.
    const connected = shp2ConnectedDpuSns(snap.devices);
    const gridDpus = dpus.filter((d) => isShp2Connected(d.sn, connected));

    let fleetPv = 0, fleetIn = 0, fleetOut = 0, acIn = 0, fleetBatteryNet = 0;
    for (const d of gridDpus) {
      fleetPv += d.projection.pvTotalWatts ?? 0;
      fleetIn += d.projection.totalInWatts ?? 0;
      fleetOut += d.projection.totalOutWatts ?? 0;
      acIn += d.projection.acInWatts ?? 0;
      // v0.10.4 — battery net from per-pack flow, not total_in/out throughput
      // (which = PV+grid in / AC out, overstating battery net ~1.7×).
      for (const pk of d.projection.packs) fleetBatteryNet += (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0);
    }
    let panelLoad = 0;
    if (shp2) for (const c of shp2.projection.circuits) panelLoad += c.watts ?? 0;

    const analytics = getAnalytics();
    const [fc, deg, runway, rte, clipping, sc, carbon, tariff] = await Promise.all([
      analytics.report('forecast'),
      analytics.report('degradation'),
      analytics.report('runway'),
      analytics.report('roundTripEfficiency'),
      analytics.report('clipping'),
      analytics.report('selfConsumption'),
      analytics.report('carbon'),
      analytics.report('tariff'),
    ]);
    const lifetime = recorder.getLifetimeTotals();
    const lifetimeKwh = (k: string) =>
      lifetime[k] ? Math.round(((lifetime[k].persistedWh + lifetime[k].pendingWh) / 1000) * 1000) / 1000 : null;
    const projecting = (deg as import('./analytics.js').FleetDegradation).packs.filter((p) => p.status === 'projecting');
    const soonest = projecting.reduce<typeof projecting[number] | null>(
      (best, p) => (best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best),
      null,
    );

    const alerts = snap.alerts ?? [];
    const cnt = (src: 'threshold' | 'learned', sev: 'critical' | 'warning' | 'info') =>
      alerts.filter((a) => (src === 'learned' ? a.source === 'learned' : a.source !== 'learned') && a.severity === sev).length;
    // v0.11.0 — per-ISA-priority counts via priorityOf (severity+source → P1..P4).
    const priorityCount = (p: AlarmPriority) => alerts.filter((a) => priorityOf(a) === p).length;
    const kwh1 = (wh: number | null | undefined) => (wh == null ? null : Math.round(wh / 100) / 10);
    return {
      fleet_pv_watts: Math.round(fleetPv),
      panel_load_watts: Math.round(panelLoad),
      ac_import_watts: Math.round(acIn),
      fleet_battery_net_watts: Math.round(fleetBatteryNet),
      off_grid: acIn < 5,
      backup_pool_percent: shp2?.projection.backupBatPercent ?? null,
      backup_remaining_kwh: kwh1(shp2?.projection.backupRemainWh),
      backup_full_capacity_kwh: kwh1(shp2?.projection.backupFullCapWh),
      forecast_pv_next_24h_kwh: Math.round(fc.forecastPvWhNext24 / 100) / 10,
      projected_low_soc_percent: fc.minProjectedSoc,
      soiling_drop_percent: fc.soiling?.dropPct ?? null,
      degradation_soonest_eol_years: soonest?.yearsToEol ?? null,
      degradation_peer_outliers: projecting.filter((p) => p.peerOutlier).length,
      runway_to_reserve_hours: runway.hoursToReserve,
      runway_to_empty_hours: runway.hoursToEmpty,
      round_trip_efficiency_percent: rte.efficiencyPct,
      pv_clipped_kwh_today: clipping.todayKwh,
      pv_array_peak_watts: clipping.arrayPeakW,
      solar_fraction_of_load_percent: sc.solarFractionOfLoadPct,
      direct_use_ratio_percent: sc.directUseRatioPct,
      pv_lifetime_kwh: lifetimeKwh('fleet_pv_wh'),
      load_lifetime_kwh: lifetimeKwh('fleet_load_wh'),
      grid_import_lifetime_kwh: lifetimeKwh('fleet_grid_import_wh'),
      battery_charge_lifetime_kwh: lifetimeKwh('fleet_battery_charge_wh'),
      battery_discharge_lifetime_kwh: lifetimeKwh('fleet_battery_discharge_wh'),
      // v0.8.0 — per-circuit lifetime + carbon + tariff
      ...Object.fromEntries(
        Object.keys(lifetime)
          .filter((k) => k.startsWith('circuit_'))
          .map((k) => [
            `circuit_${k.match(/^circuit_(\d+)_wh$/)?.[1]}_lifetime_kwh`,
            lifetimeKwh(k),
          ]),
      ),
      carbon_kg_avoided_7d: carbon.totalKgAvoided,
      carbon_lifetime_kg_avoided: carbon.lifetimeKgAvoided,
      carbon_lifetime_miles_not_driven: carbon.lifetimeMilesNotDriven,
      tariff_today_grid_cost_dollars: tariff.todayGridImportCostDollars,
      tariff_today_solar_value_dollars: tariff.todaySolarLoadValueDollars,
      tariff_net_savings_7d_dollars: tariff.netSavingsDollars,
      alert_critical_count: cnt('threshold', 'critical'),
      alert_warning_count: cnt('threshold', 'warning'),
      learned_warning_count: cnt('learned', 'warning'),
      // v0.11.0 — additive per-priority alarm counts (P1 Critical … P4 Low).
      alert_high_count: priorityCount('high'),
      alert_medium_count: priorityCount('medium'),
      alert_low_count: priorityCount('low'),
      fleet_devices_online: devices.filter((d) => d.online).length,
    };
  };

  const publishState = async () => {
    if (!client.connected) return;
    try {
      const state = await buildState(store.get());
      client.publish(STATE_TOPIC, JSON.stringify(state), { retain: true, qos: 0 });
    } catch (e: any) {
      log(`mqtt-discovery: state publish failed — ${e?.message ?? e}`);
    }
  };

  // v0.11.0 — fast lookup from a switch command topic back to its priority,
  // so the message handler can map an incoming ON/OFF to the right setting.
  const commandTopicToPriority = new Map<string, AlarmPriority>(
    ALARM_PRIORITY_ORDER.map((p) => [alertSwitchCommandTopic(p), p]),
  );

  // v0.11.0 — HA toggled a switch: apply it to alertSettings (source 'mqtt'),
  // then echo the resolved state back to that switch's STATE topic. We publish
  // to the STATE topic (not the COMMAND topic) so this never re-triggers the
  // command handler — no feedback loop.
  const handleSwitchCommand = (topic: string, payloadRaw: string) => {
    const p = commandTopicToPriority.get(topic);
    if (!p) return;
    const payload = payloadRaw.trim().toUpperCase();
    if (payload !== SWITCH_ON && payload !== SWITCH_OFF) return;
    const enabled = payload === SWITCH_ON;
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
    if (!published) {
      // Clear legacy unique_ids FIRST so HA processes the removal alongside
      // the (re)publish of the canonical configs in the same session.
      clearLegacyDiscovery();
      publishDiscovery();
      published = true;
    }
    // Subscribe to every switch command topic (re-subscribe on each reconnect —
    // MQTT subscriptions don't survive a clean session reconnect).
    for (const p of ALARM_PRIORITY_ORDER) {
      client.subscribe(alertSwitchCommandTopic(p), { qos: 0 }, (err) => {
        if (err) log(`mqtt-discovery: subscribe ${alertSwitchCommandTopic(p)} failed — ${err.message}`);
      });
    }
    publishState();
    publishSwitchStates();
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
