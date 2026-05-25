import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, startPollLoop } from './snapshot.js';
import type { DeviceSnapshot } from './snapshot.js';
import { startMqtt } from './ecoflow/mqtt.js';
import { createRecorder } from './recorder.js';
import { computeTotals, startOfLocalDayMs, circuitHistoryByDay } from './aggregator.js';
import { startAlertMonitor } from './alertMonitor.js';
import { isConfigured } from './notify.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
  computeThermalEvents,
  computeEquipmentHealth,
  computeShadeReport,
  computeSoilingDecomposition,
  computeStringMismatch,
  computeEvWindowPrediction,
  computeChargeCurveFingerprint,
  computeInternalResistance,
  computeForecastSkill,
  computeAmbientThermalForecast,
  computeConfidenceSnapshot,
  getActiveNwsAlerts,
  // v0.8.0 additions
  computeCarbonReport,
  computeTariffReport,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeDispatchPlan,
  rootCausesFor,
  // v0.9.0 additions — Bayesian + Kalman + risk score
  computeBayesianSolarModel,
  computePackRiskScores,
} from './analytics.js';
import type { DpuProjection, Shp2Projection } from './ecoflow/project.js';
import { startTelnetServer } from './telnet/server.js';
import { startMqttDiscovery } from './mqttDiscovery.js';
import { buildCalendarIcs } from './calendar.js';
import { computeRepairIssues } from './repairIssues.js';
import { getWeather } from './weather.js';

// REST polling cadence. MQTT now delivers per-cmdId fresh data, but we keep a
// 60s REST poll as a baseline for fields that MQTT doesn't emit and as recovery
// after broker disconnects.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

const app = Fastify({ logger: { level: config.logLevel } });
await app.register(cors, { origin: true });
await app.register(websocket);

// Serve the built web UI at `/`, with SPA fallback. Present in production
// (Home Assistant add-on, `npm run build` output); absent in dev, where Vite
// is the front-end server and proxies /api and /ws back to this process.
const webDist =
  process.env.WEB_DIST_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
  app.log.info(`web: serving built UI from ${webDist}`);
} else {
  app.log.info(`web: no built bundle at ${webDist} (dev mode — Vite at :5173)`);
}

const store = new SnapshotStore();
const recorder = createRecorder(store, (m) => app.log.info(m));

app.get('/api/snapshot', async () => store.get());
app.get('/api/health', async () => ({ ok: true, generatedAt: store.get().generatedAt }));

app.get<{ Querystring: { sn?: string; metric?: string; since?: string; until?: string; bucket?: string } }>(
  '/api/history',
  async (req, reply) => {
    const { sn, metric, since, until, bucket } = req.query;
    if (!sn || !metric) {
      reply.code(400);
      return { error: 'sn and metric required' };
    }
    const sinceMs = since ? Number(since) : Date.now() - 60 * 60 * 1000;
    const untilMs = until ? Number(until) : Date.now();
    const bucketSec = bucket ? Number(bucket) : undefined;
    const points = recorder.query(sn, metric, sinceMs, untilMs, bucketSec);
    return { sn, metric, sinceMs, untilMs, bucketSec, points };
  },
);

app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today', async (req) => {
  const since = req.query.since ? Number(req.query.since) : startOfLocalDayMs();
  const until = req.query.until ? Number(req.query.until) : Date.now();
  return computeTotals(store, recorder, since, until);
});

/**
 * Per-circuit daily kWh history for the CircuitModal's multi-day comparison.
 * Returns the last `days` (default 7, max 30) of trapezoidal kWh + peak watt +
 * peak timestamp + coverage, plus a summary block (avg, peak day, min day).
 */
app.get<{ Querystring: { sn?: string; ch?: string; days?: string } }>(
  '/api/circuit/history',
  async (req, reply) => {
    const { sn, ch, days } = req.query;
    if (!sn || !ch) {
      reply.code(400);
      return { error: 'sn and ch required' };
    }
    const chNum = Number(ch);
    if (!Number.isInteger(chNum) || chNum < 1) {
      reply.code(400);
      return { error: 'ch must be a positive integer' };
    }
    const daysNum = Math.max(1, Math.min(30, Number(days ?? 7) || 7));
    return circuitHistoryByDay(recorder, sn, chNum, daysNum);
  },
);

app.get<{ Querystring: { sn?: string } }>('/api/debug/raw', async (req, reply) => {
  const sn = req.query.sn;
  if (!sn) {
    reply.code(400);
    return { error: 'sn required' };
  }
  return {
    sn,
    raw: store.getRaw(sn) ?? null,
    mqtt: store.getMqttByCmd(sn),
    mqttFlat: store.getMqttFlat(sn) ?? null,
    source: store.lastSourceBySn.get(sn) ?? null,
    lastMqttAt: store.lastMqttAtBySn.get(sn) ?? null,
    mqttMsgCount: store.mqttMsgCountBySn.get(sn) ?? 0,
  };
});

app.get('/api/debug/mqtt-summary', async () => {
  const list = Object.keys(store.get().devices);
  return list.map((sn) => ({
    sn,
    deviceName: store.get().devices[sn]?.deviceName,
    msgCount: store.mqttMsgCountBySn.get(sn) ?? 0,
    lastMqttAt: store.lastMqttAtBySn.get(sn) ?? null,
    cmdIds: Object.keys(store.getMqttByCmd(sn)).map(Number).sort((a, b) => a - b),
  }));
});

app.get<{ Querystring: { sn?: string } }>('/api/metrics', async (req, reply) => {
  const sn = req.query.sn;
  if (!sn) {
    reply.code(400);
    return { error: 'sn required' };
  }
  return { sn, metrics: recorder.listMetrics(sn) };
});

app.get('/api/forecast', async () => getDayForecast(store.get().devices, recorder, (m) => app.log.info(m)));

app.get('/api/degradation', async () => computeDegradation(store.get().devices, recorder));

app.get('/api/runway', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return computeRunway(store.get().devices, recorder, fc);
});

app.get<{ Querystring: { days?: string } }>('/api/round-trip-efficiency', async (req) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return computeRoundTripEfficiency(store.get().devices, recorder, days);
});

app.get('/api/clipping', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return computeClipping(store.get().devices, recorder, fc);
});

// v0.7.6 — lifetime energy counters for HA Energy Dashboard.
// Each entry: { persistedWh, pendingWh, watermarkMs } — live total = persistedWh + pendingWh.
// HA expects monotonically-increasing kWh with state_class=total_increasing.
app.get('/api/lifetime-energy', async () => {
  const totals = recorder.getLifetimeTotals();
  // Convert to kWh and expose both raw + summed views.
  const toKwh = (wh: number) => Math.round((wh / 1000) * 1000) / 1000;
  const live = (k: keyof typeof totals) =>
    toKwh(totals[k].persistedWh + totals[k].pendingWh);
  return {
    generated_at: Date.now(),
    pv_lifetime_kwh: live('fleet_pv_wh'),
    load_lifetime_kwh: live('fleet_load_wh'),
    grid_import_lifetime_kwh: live('fleet_grid_import_wh'),
    battery_charge_lifetime_kwh: live('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: live('fleet_battery_discharge_wh'),
    details: totals,
  };
});

// v0.7.5 — new analytics endpoints
app.get<{ Querystring: { days?: string } }>('/api/self-consumption', async (req) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return computeSelfConsumption(store.get().devices, recorder, days);
});

app.get('/api/thermal-events', async () => computeThermalEvents(store.get().devices, recorder));

app.get('/api/equipment-health', async () => computeEquipmentHealth(store.get().devices, recorder));

app.get('/api/shade-report', async () => computeShadeReport(store.get().devices, recorder));

app.get('/api/soiling-decomposition', async () => computeSoilingDecomposition(store.get().devices, recorder));

app.get('/api/string-mismatch', async () => computeStringMismatch(store.get().devices, recorder));

app.get('/api/ev-window-prediction', async () => computeEvWindowPrediction(store.get().devices, recorder));

app.get('/api/charge-curve', async () => computeChargeCurveFingerprint(store.get().devices, recorder));

app.get('/api/internal-resistance', async () => computeInternalResistance(store.get().devices, recorder));

app.get<{ Querystring: { days?: string } }>('/api/forecast-skill', async (req) => {
  const days = Math.max(1, Math.min(14, Number(req.query.days ?? 7) || 7));
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return computeForecastSkill(store.get().devices, recorder, fc, days);
});

app.get('/api/ambient-thermal-forecast', async () => computeAmbientThermalForecast(store.get().devices, recorder));

app.get('/api/confidence', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const deg = computeDegradation(store.get().devices, recorder);
  const thermal = await computeAmbientThermalForecast(store.get().devices, recorder);
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return computeConfidenceSnapshot(deg, fc, thermal, skill);
});

app.get('/api/nws-alerts', async () => ({ alerts: await getActiveNwsAlerts() }));

// v0.9.2 — weather ensemble (Open-Meteo + NWS NDFD when enabled). Returns
// the underlying forecast with per-hour ensembleSources + disagreement
// metadata so consumers can see WHY the bands are wider on hours with
// high inter-source disagreement.
app.get('/api/weather/ensemble', async () => {
  const w = await getWeather((m) => app.log.info(m));
  if (!w) return { error: 'no weather available' };
  return {
    fetchedAt: w.fetchedAt,
    lat: w.lat, lon: w.lon,
    sourcesCount: w.ensembleSourcesCount ?? 1,
    avgDisagreementPct: w.ensembleAvgDisagreement ?? 0,
    hourCount: w.hours.length,
    enrichedHourCount: w.hours.filter((h) => (h.ensembleSources ?? 1) > 1).length,
    hours: w.hours.map((h) => ({
      ts: h.ts,
      cloudCoverPct: h.cloudCoverPct,
      radiationWm2: h.radiationWm2,
      ensembleSources: h.ensembleSources ?? 1,
      disagreementPct: h.ensembleDisagreementPct ?? null,
    })),
  };
});

app.get('/api/incidents', async () => ({ incidents: monitor.incidents() }));

app.get('/api/alert-telemetry', async () => ({ telemetry: monitor.telemetry() }));

// v0.8.0 — sustainability, tariff, probabilistic forecasts, multi-day,
// dispatch planner, calendar, repair issues
app.get<{ Querystring: { days?: string } }>('/api/carbon', async (req) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return computeCarbonReport(store.get().devices, recorder, days);
});

app.get<{ Querystring: { days?: string } }>('/api/tariff', async (req) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return computeTariffReport(store.get().devices, recorder, days);
});

app.get('/api/forecast/probabilistic', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return computeProbabilisticForecast(fc, skill);
});

app.get<{ Querystring: { days?: string } }>('/api/forecast/multi-day', async (req) => {
  const days = Math.max(1, Math.min(7, Number(req.query.days ?? 3) || 3));
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return computeMultiDayForecast(store.get().devices, recorder, fc, days);
});

app.get('/api/dispatch-plan', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return computeDispatchPlan(store.get().devices, fc);
});

app.get('/api/root-cause', async (req) => {
  const id = (req.query as any).alertId as string | undefined;
  if (!id) return { causes: [] };
  return { causes: rootCausesFor(id) };
});

app.get('/api/calendar.ics', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const ev = computeEvWindowPrediction(store.get().devices, recorder);
  const nws = await getActiveNwsAlerts();
  const ics = buildCalendarIcs({ devices: store.get().devices, forecast: fc, evWindow: ev, nwsAlerts: nws });
  reply
    .header('Content-Type', 'text/calendar; charset=utf-8')
    .header('Content-Disposition', 'inline; filename="ecoflow-panel.ics"')
    // HTTP-layer cache (HA's generic_ics_calendar honors this). Function-
    // level cache was removed in v0.8.1 since it was effectively unkeyed.
    .header('Cache-Control', 'public, max-age=300');
  return ics;
});

// v0.9.0 — Bayesian solar model + Pack Risk Scores
app.get('/api/forecast/bayesian', async () => {
  return computeBayesianSolarModel(store.get().devices, recorder);
});

app.get('/api/pack-risk', async () => {
  const deg = computeDegradation(store.get().devices, recorder);
  const therm = computeThermalEvents(store.get().devices, recorder);
  const ir = computeInternalResistance(store.get().devices, recorder);
  const cc = computeChargeCurveFingerprint(store.get().devices, recorder);
  return computePackRiskScores(store.get().devices, deg, therm, ir, cc);
});

app.get('/api/repair-issues', async () => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return computeRepairIssues({
    devices: store.get().devices,
    alerts: store.get().alerts ?? [],
    degradation: computeDegradation(store.get().devices, recorder),
    soiling: await computeSoilingDecomposition(store.get().devices, recorder),
    equipmentHealth: computeEquipmentHealth(store.get().devices, recorder),
    forecastSkill: skill,
  });
});

/**
 * Flat key-value snapshot for Home Assistant REST sensors. One HTTP call
 * returns every metric we expose as an HA entity (`configuration.yaml`
 * snippet is in DOCS.md). Cached forecast + degradation are reused, so
 * HA can poll this every 30s without hammering the recorder.
 */
app.get('/api/ha-state', async () => {
  const snap = store.get();
  const devices = Object.values(snap.devices);
  type DpuDev = DeviceSnapshot & { projection: DpuProjection };
  type Shp2Dev = DeviceSnapshot & { projection: Shp2Projection };

  const dpus = (devices as DpuDev[]).filter((d) => d.online && d.projection?.kind === 'dpu');
  const shp2 = (devices as Shp2Dev[]).find((d) => d.projection?.kind === 'shp2');

  // Power flow — sum across the online DPUs.
  let fleetPv = 0, fleetIn = 0, fleetOut = 0;
  for (const d of dpus) {
    fleetPv += d.projection.pvTotalWatts ?? 0;
    fleetIn += d.projection.totalInWatts ?? 0;
    fleetOut += d.projection.totalOutWatts ?? 0;
  }

  // Grid import — only count AC-in on SHP2-bound DPUs. A spare DPU plugged
  // into a wall outlet for self-charging does NOT make the house grid-tied.
  let acIn = 0;
  if (shp2) {
    const sourceSns = new Set(
      shp2.projection.sources.map((s) => s.sn).filter((s): s is string => !!s),
    );
    const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus;
    for (const d of gridDpus) acIn += d.projection.acInWatts ?? 0;
  }

  // Panel load = sum of SHP2 circuit watts.
  let panelLoad = 0;
  if (shp2) for (const c of shp2.projection.circuits) panelLoad += c.watts ?? 0;

  // Cached projections (internally cached ~30min — cheap to call per-request).
  const fc = await getDayForecast(snap.devices, recorder, () => {});
  const deg = computeDegradation(snap.devices, recorder);
  const runway = computeRunway(snap.devices, recorder, fc);
  const rte = computeRoundTripEfficiency(snap.devices, recorder);
  const clipping = await computeClipping(snap.devices, recorder, fc);
  const selfCons = computeSelfConsumption(snap.devices, recorder);
  const lifetime = recorder.getLifetimeTotals();
  const lifetimeKwh = (k: string) =>
    lifetime[k] ? Math.round(((lifetime[k].persistedWh + lifetime[k].pendingWh) / 1000) * 1000) / 1000 : null;
  // v0.8.0 additions
  const carbon = computeCarbonReport(snap.devices, recorder);
  const tariff = computeTariffReport(snap.devices, recorder);

  // Soonest projected EOL = the pack with the fewest years left.
  const projecting = deg.packs.filter((p) => p.status === 'projecting');
  type Pack = (typeof projecting)[number];
  const soonest = projecting.reduce<Pack | null>(
    (best, p) => (best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best),
    null,
  );
  const peerOutliers = projecting.filter((p) => p.peerOutlier);
  const eolLabel = (p: Pack | null) =>
    p == null
      ? null
      : p.coreNum != null
        ? `Core ${p.coreNum} · Pack ${p.packNum}`
        : `${p.device} · Pack ${p.packNum}`;

  // Alert counts split by source × severity.
  const alerts = snap.alerts ?? [];
  const cnt = (src: 'threshold' | 'learned', sev: 'critical' | 'warning' | 'info') =>
    alerts.filter(
      (a) => (src === 'learned' ? a.source === 'learned' : a.source !== 'learned') && a.severity === sev,
    ).length;

  // SHP2 backup pool stats — round Wh→kWh to one decimal, null-safe.
  const kwh1 = (wh: number | null | undefined) => (wh == null ? null : Math.round(wh / 100) / 10);

  return {
    generated_at: snap.generatedAt,

    // Power flow (watts, integers)
    fleet_pv_watts: Math.round(fleetPv),
    fleet_total_in_watts: Math.round(fleetIn),
    fleet_total_out_watts: Math.round(fleetOut),
    fleet_battery_net_watts: Math.round(fleetOut - fleetIn), // positive = discharging
    panel_load_watts: Math.round(panelLoad),
    ac_import_watts: Math.round(acIn),
    off_grid: acIn < 5,

    // Battery — SHP2 backup pool
    backup_pool_percent: shp2?.projection.backupBatPercent ?? null,
    backup_reserve_percent: shp2?.projection.backupReserveSoc ?? null,
    backup_full_capacity_kwh: kwh1(shp2?.projection.backupFullCapWh),
    backup_remaining_kwh: kwh1(shp2?.projection.backupRemainWh),
    backup_charge_minutes: shp2?.projection.backupChargeTimeMin ?? null,
    backup_discharge_minutes: shp2?.projection.backupDischargeTimeMin ?? null,

    // Forecast (cached ~30min)
    forecast_pv_next_24h_kwh: Math.round(fc.forecastPvWhNext24 / 100) / 10,
    typical_pv_per_day_kwh: Math.round(fc.typicalPvWhPerDay / 100) / 10,
    projected_low_soc_percent: fc.minProjectedSoc,
    projected_low_soc_at: fc.minProjectedSocTs,
    forecast_history_days: fc.historyDays,
    forecast_has_weather: fc.hasWeather,
    soiling_drop_percent: fc.soiling?.dropPct ?? null,

    // Degradation (cached ~30min)
    degradation_packs_total: deg.packs.length,
    degradation_packs_projecting: projecting.length,
    degradation_soonest_eol_years: soonest?.yearsToEol ?? null,
    degradation_soonest_eol_date: soonest?.eolDate ?? null,
    degradation_soonest_eol_pack: eolLabel(soonest),
    degradation_peer_outliers: peerOutliers.length,

    // Alerts (split by engine source and severity)
    alert_critical_count: cnt('threshold', 'critical'),
    alert_warning_count: cnt('threshold', 'warning'),
    alert_info_count: cnt('threshold', 'info'),
    learned_critical_count: cnt('learned', 'critical'),
    learned_warning_count: cnt('learned', 'warning'),
    learned_info_count: cnt('learned', 'info'),

    // Runway — live off-grid projection (v0.5.0)
    runway_to_reserve_hours: runway.hoursToReserve,
    runway_to_empty_hours: runway.hoursToEmpty,
    runway_recent_load_watts: runway.recentLoadWatts,
    runway_forecast_pv_used_kwh: runway.forecastPvUsedKwh,

    // Round-trip efficiency — 7-day rolling (v0.5.0)
    round_trip_efficiency_percent: rte.efficiencyPct,
    round_trip_charged_kwh_7d: rte.totalChargedKwh,
    round_trip_discharged_kwh_7d: rte.totalDischargedKwh,

    // Inverter clipping — kWh lost today because the arrays produced more
    // DC than the hardware could pass through (v0.6.0).
    pv_clipped_kwh_today: clipping.todayKwh,
    pv_array_peak_watts: clipping.arrayPeakW,
    pv_hours_at_peak_today: clipping.hoursAtPeak,

    // Self-consumption — 7-day rolling (v0.7.5)
    pv_kwh_7d: selfCons.pvKwh,
    load_kwh_7d: selfCons.loadKwh,
    battery_charge_kwh_7d: selfCons.batteryChargeKwh,
    battery_discharge_kwh_7d: selfCons.batteryDischargeKwh,
    grid_import_kwh_7d: selfCons.gridImportKwh,
    solar_fraction_of_load_percent: selfCons.solarFractionOfLoadPct,
    direct_use_ratio_percent: selfCons.directUseRatioPct,

    // Lifetime monotonic energy counters for HA Energy Dashboard (v0.7.6).
    // state_class: total_increasing — survive samples-table pruning via the
    // persistent `lifetime_totals` table; battery counters come from the BMS.
    pv_lifetime_kwh: lifetimeKwh('fleet_pv_wh'),
    load_lifetime_kwh: lifetimeKwh('fleet_load_wh'),
    grid_import_lifetime_kwh: lifetimeKwh('fleet_grid_import_wh'),
    battery_charge_lifetime_kwh: lifetimeKwh('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: lifetimeKwh('fleet_battery_discharge_wh'),

    // Per-circuit lifetime kWh (v0.8.0) — one row per SHP2 circuit, each
    // appears as an HA Energy Dashboard "Individual device". Dynamic field
    // names: circuit_<ch>_lifetime_kwh.
    ...Object.fromEntries(
      Object.keys(lifetime)
        .filter((k) => k.startsWith('circuit_'))
        .map((k) => {
          const ch = k.match(/^circuit_(\d+)_wh$/)?.[1];
          return [`circuit_${ch}_lifetime_kwh`, lifetimeKwh(k)];
        }),
    ),

    // Sustainability — carbon offset / equivalent miles avoided (v0.8.0)
    carbon_kg_avoided_7d: carbon.totalKgAvoided,
    carbon_lifetime_kg_avoided: carbon.lifetimeKgAvoided,
    carbon_lifetime_miles_not_driven: carbon.lifetimeMilesNotDriven,
    carbon_grid_intensity_kg_per_kwh: carbon.gridCo2IntensityKgPerKwh,

    // TOU tariff cost tracking (v0.8.0)
    tariff_grid_import_cost_7d_dollars: tariff.gridImportCostDollars,
    tariff_solar_load_value_7d_dollars: tariff.solarLoadValueDollars,
    tariff_net_savings_7d_dollars: tariff.netSavingsDollars,
    tariff_today_grid_cost_dollars: tariff.todayGridImportCostDollars,
    tariff_today_solar_value_dollars: tariff.todaySolarLoadValueDollars,
    tariff_on_peak_cents: tariff.onPeakCents,
    tariff_off_peak_cents: tariff.offPeakCents,

    // Connectivity
    fleet_devices_total: devices.length,
    fleet_devices_online: devices.filter((d) => d.online).length,
  };
});

app.get('/api/notify/status', async () => {
  const cfg = monitor.getConfig();
  return {
    channel: cfg.channel,
    configured: isConfigured(cfg),
    minSeverity: cfg.minSeverity,
    notifyResolved: cfg.notifyResolved,
    // ntfy topic is shown so the user knows what to subscribe to; it's a LAN-only dashboard.
    ntfyServer: cfg.channel === 'ntfy' ? cfg.ntfyServer : undefined,
    ntfyTopic: cfg.channel === 'ntfy' ? cfg.ntfyTopic : undefined,
    ...monitor.stats(),
  };
});

app.post('/api/notify/test', async (_req, reply) => {
  try {
    await monitor.sendTest();
    return { ok: true };
  } catch (e: any) {
    reply.code(400);
    return { ok: false, error: String(e?.message ?? e) };
  }
});

app.get('/api/alerts/history', async () => ({ cleared: monitor.history() }));

app.get('/ws', { websocket: true }, (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', data: store.get() }));
  const onChange = (snap: any) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'snapshot', data: snap }));
    }
  };
  store.on('change', onChange);
  socket.on('close', () => store.off('change', onChange));
});

const stopPoll = startPollLoop(store, POLL_INTERVAL_MS, (m) => app.log.info(m));

// MQTT is best-effort; if it fails, REST polling still works.
let stopMqtt: (() => void) | null = null;
try {
  const mqttHandle = await startMqtt(store, (m) => app.log.info(m));
  stopMqtt = mqttHandle.stop;
} catch (e: any) {
  app.log.error(`mqtt: failed to start, falling back to REST polling: ${e?.message ?? e}`);
}

// Alert monitor: computes fleet alerts, attaches to the snapshot, pushes notifications.
const monitor = startAlertMonitor(store, recorder, (m) => app.log.info(m));
app.log.info(
  `notify: channel=${monitor.getConfig().channel} configured=${isConfigured(monitor.getConfig())}`,
);

// Telnet control-room TUI — a menu-driven terminal view of the whole fleet.
let stopTelnet: (() => void) | null = null;
if (config.telnet.enabled) {
  try {
    stopTelnet = startTelnetServer({
      store,
      recorder,
      host: config.telnet.host,
      port: config.telnet.port,
      log: (m) => app.log.info(m),
    }).stop;
    app.log.info(`telnet: control-room TUI on telnet://${config.telnet.host}:${config.telnet.port}`);
  } catch (e: any) {
    app.log.error(`telnet: failed to start: ${e?.message ?? e}`);
  }
}

// HA MQTT Discovery — opt-in. When wired to the user's HA MQTT broker, every
// sensor we expose auto-registers under the "EcoFlow Panel" device with no
// YAML edit required. Falls back silently when the feature is disabled.
let stopMqttDiscovery: (() => void) | null = null;
try {
  const discoveryHandle = await startMqttDiscovery(store, recorder, (m) => app.log.info(m));
  stopMqttDiscovery = discoveryHandle.stop;
} catch (e: any) {
  app.log.error(`mqtt-discovery: failed to start: ${e?.message ?? e}`);
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`EcoFlow panel API listening on http://${config.host}:${config.port}`);

const shutdown = async () => {
  app.log.info('shutting down');
  stopPoll();
  stopMqtt?.();
  monitor.stop();
  stopTelnet?.();
  stopMqttDiscovery?.();
  recorder.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
