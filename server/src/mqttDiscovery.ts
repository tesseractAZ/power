import mqtt, { MqttClient } from 'mqtt';
import type { SnapshotStore, FleetSnapshot } from './snapshot.js';
import type { Recorder } from './recorder.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
} from './analytics.js';

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
  sw_version: '0.7.5',
};

const STATE_TOPIC = 'ecoflow_panel/state';
const AVAILABILITY_TOPIC = 'ecoflow_panel/availability';
const PUBLISH_INTERVAL_MS = 30 * 1000;

interface SensorConfig {
  unique_id: string;
  name: string;
  device_class?: string;
  state_class?: string;
  unit_of_measurement?: string;
  icon?: string;
  value_template: string;
}

const SENSORS: SensorConfig[] = [
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
  { unique_id: 'ecoflow_pv_array_peak_watts', name: 'EcoFlow PV Array Peak', device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', value_template: '{{ value_json.pv_array_peak_watts }}' },
  // Self-consumption (v0.7.5)
  { unique_id: 'ecoflow_solar_fraction_of_load', name: 'EcoFlow Solar Fraction of Load', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:solar-power', value_template: '{{ value_json.solar_fraction_of_load_percent }}' },
  { unique_id: 'ecoflow_direct_use_ratio', name: 'EcoFlow PV Direct Use Ratio', state_class: 'measurement', unit_of_measurement: '%', icon: 'mdi:transmission-tower-import', value_template: '{{ value_json.direct_use_ratio_percent }}' },
  // Alert counts
  { unique_id: 'ecoflow_alert_critical_count', name: 'EcoFlow Critical Alerts', state_class: 'measurement', icon: 'mdi:alert-octagon', value_template: '{{ value_json.alert_critical_count }}' },
  { unique_id: 'ecoflow_alert_warning_count', name: 'EcoFlow Warning Alerts', state_class: 'measurement', icon: 'mdi:alert', value_template: '{{ value_json.alert_warning_count }}' },
  { unique_id: 'ecoflow_learned_warning_count', name: 'EcoFlow Learned Warnings', state_class: 'measurement', icon: 'mdi:lightbulb-on', value_template: '{{ value_json.learned_warning_count }}' },
  // Fleet
  { unique_id: 'ecoflow_fleet_devices_online', name: 'EcoFlow Fleet Devices Online', state_class: 'measurement', icon: 'mdi:home-battery', value_template: '{{ value_json.fleet_devices_online }}' },
];

const BINARY_SENSORS = [
  { unique_id: 'ecoflow_off_grid', name: 'EcoFlow Off-Grid', device_class: 'connectivity', icon: 'mdi:transmission-tower-off', value_template: '{{ "ON" if value_json.off_grid else "OFF" }}' },
];

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
    will: { topic: AVAILABILITY_TOPIC, payload: 'offline', retain: true, qos: 0 },
  });

  let published = false;
  let timer: NodeJS.Timeout | null = null;

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
    client.publish(AVAILABILITY_TOPIC, 'online', { retain: true, qos: 0 });
    log(`mqtt-discovery: published ${SENSORS.length} sensor configs + ${BINARY_SENSORS.length} binary_sensor configs to ${url} (prefix=${prefix})`);
  };

  const buildState = async (snap: FleetSnapshot): Promise<Record<string, unknown>> => {
    const devices = Object.values(snap.devices);
    type DpuDev = typeof devices[number] & { projection: DpuProjection };
    type Shp2Dev = typeof devices[number] & { projection: Shp2Projection };
    const dpus = (devices as DpuDev[]).filter((d) => d.online && d.projection?.kind === 'dpu');
    const shp2 = (devices as Shp2Dev[]).find((d) => d.projection?.kind === 'shp2');

    let fleetPv = 0, fleetIn = 0, fleetOut = 0, acIn = 0;
    for (const d of dpus) {
      fleetPv += d.projection.pvTotalWatts ?? 0;
      fleetIn += d.projection.totalInWatts ?? 0;
      fleetOut += d.projection.totalOutWatts ?? 0;
    }
    if (shp2) {
      const sourceSns = new Set(shp2.projection.sources.map((s) => s.sn).filter((s): s is string => !!s));
      const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
      for (const d of gridDpus) acIn += d.projection.acInWatts ?? 0;
    }
    let panelLoad = 0;
    if (shp2) for (const c of shp2.projection.circuits) panelLoad += c.watts ?? 0;

    const fc = await getDayForecast(snap.devices, recorder, () => {});
    const deg = computeDegradation(snap.devices, recorder);
    const runway = computeRunway(snap.devices, recorder, fc);
    const rte = computeRoundTripEfficiency(snap.devices, recorder);
    const clipping = await computeClipping(snap.devices, recorder, fc);
    const sc = computeSelfConsumption(snap.devices, recorder);

    const projecting = deg.packs.filter((p) => p.status === 'projecting');
    const soonest = projecting.reduce<typeof projecting[number] | null>(
      (best, p) => (best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best),
      null,
    );

    const alerts = snap.alerts ?? [];
    const cnt = (src: 'threshold' | 'learned', sev: 'critical' | 'warning' | 'info') =>
      alerts.filter((a) => (src === 'learned' ? a.source === 'learned' : a.source !== 'learned') && a.severity === sev).length;
    const kwh1 = (wh: number | null | undefined) => (wh == null ? null : Math.round(wh / 100) / 10);
    return {
      fleet_pv_watts: Math.round(fleetPv),
      panel_load_watts: Math.round(panelLoad),
      ac_import_watts: Math.round(acIn),
      fleet_battery_net_watts: Math.round(fleetOut - fleetIn),
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
      alert_critical_count: cnt('threshold', 'critical'),
      alert_warning_count: cnt('threshold', 'warning'),
      learned_warning_count: cnt('learned', 'warning'),
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

  client.on('connect', () => {
    log(`mqtt-discovery: connected to ${url}`);
    if (!published) {
      publishDiscovery();
      published = true;
    }
    publishState();
  });
  client.on('error', (e) => log(`mqtt-discovery: ${e.message}`));
  client.on('reconnect', () => log('mqtt-discovery: reconnecting'));

  timer = setInterval(() => publishState(), PUBLISH_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      client.publish(AVAILABILITY_TOPIC, 'offline', { retain: true, qos: 0 });
      client.end(true);
    },
    client,
  };
}
