import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { createHash } from 'node:crypto';
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
// v0.9.18 — ship-wide audible broadcast to HomePod/Sonos via HA media_player.
import { generateAudioAssets } from './audioAssets.js';
import { startBroadcastMonitor } from './broadcast.js';
import { getAllStates } from './haService.js';
// v0.9.25 — feedback-loop foundation
import { appendAlertOutcome, tailAlertOutcomes, computeFamilyStats, type AlertOutcome } from './alertOutcomes.js';
import { getSnapshot, dropSnapshot } from './featureSnapshot.js';
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
import { computePackRiskV2 } from './ml.js';
import { startCacheWarmer } from './cacheWarmer.js';
import {
  refreshShp2CloudPresence,
  debugSendCommand,
  isWriteDebugEnabled,
  checkWriteDebugToken,
  cooldownRemainingMs,
  REFRESH_COOLDOWN_MS,
} from './ecoflow/commands.js';
import { tailWriteLog } from './writeLog.js';

// REST polling cadence. MQTT now delivers per-cmdId fresh data, but we keep a
// 60s REST poll as a baseline for fields that MQTT doesn't emit and as recovery
// after broker disconnects.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

const app = Fastify({ logger: { level: config.logLevel } });
// v0.9.7 — defense in depth: accept empty-body POSTs even when the client
// (wrongly) sets Content-Type: application/json. Without this Fastify
// rejects with FST_ERR_CTP_EMPTY_JSON_BODY — which broke the first
// build of the reboot button. The right client fix is to omit the header
// for bodiless POSTs (already done in RebootButton.tsx), but treating an
// empty JSON body as `{}` is a safer default for every future POST.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const s = (body as string).trim();
  if (s === '') return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch (e) {
    done(e as Error, undefined);
  }
});
await app.register(cors, { origin: true });
// v0.9.14 — permessage-deflate on WebSocket frames. SnapshotStore pushes
// the full snapshot on every change (~50-150 KB raw JSON for a 13-device
// fleet); with PMD enabled, that compresses to ~10-30 KB per frame. Saves
// real bandwidth over HA Ingress + on mobile, especially when MQTT chatter
// triggers frequent change events. Threshold filters out tiny frames where
// the deflate framing overhead would dominate.
await app.register(websocket, {
  options: {
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 6 },
    },
  },
});
// v0.9.14 — gzip/brotli on every response over 1 kB. JSON payloads (snapshot,
// ha-state, history) typically compress 70-85%; the savings show up most over
// HA Ingress and on mobile. `global: true` covers static assets too; the
// threshold filters out small responses where the framing cost would dominate.
await app.register(compress, {
  global: true,
  encodings: ['br', 'gzip'],
  threshold: 1024,
});

/**
 * v0.9.14 — cache helper for read-mostly endpoints.
 *
 * Adds a strong ETag (sha-1 of the payload), short Cache-Control max-age,
 * and short-circuits with 304 Not Modified when the client's
 * `If-None-Match` matches. Use on endpoints where the same response is
 * safely re-served for a few seconds (history, ha-state, summary/today).
 *
 * Does NOT mutate `body` — returns it for chaining: `return cached(req, reply, payload, 30)`.
 */
function cached<T>(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, body: T, maxAgeSec = 30): T {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(json).digest('base64').slice(0, 22)}"`;
  reply.header('Cache-Control', `private, max-age=${maxAgeSec}`);
  reply.header('ETag', etag);
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    reply.code(304).send();
    return body; // body is irrelevant — Fastify already sent 304 + closed stream
  }
  return body;
}

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

// v0.9.18 — synthesise the Starfleet alert klaxon WAVs at startup and
// serve them at /audio/*. HomePod / Sonos stream these URLs when we
// broadcast condition transitions via Home Assistant's media_player.
const audioDir = resolve(process.env.DATA_DIR ?? '/data', 'audio');
await generateAudioAssets(audioDir, (m) => app.log.info(m));
await app.register(fastifyStatic, {
  root: audioDir,
  prefix: '/audio/',
  decorateReply: false,
  wildcard: false,
});

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
    // v0.9.14 — short Cache-Control + ETag so repeat fetches from the same
    // dashboard tab return 304. History rows are append-only; 15s of staleness
    // on the trailing edge is fine for chart UX.
    return cached(req, reply, { sn, metric, sinceMs, untilMs, bucketSec, points }, 15);
  },
);

app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today', async (req, reply) => {
  const since = req.query.since ? Number(req.query.since) : startOfLocalDayMs();
  const until = req.query.until ? Number(req.query.until) : Date.now();
  return cached(req, reply, computeTotals(store, recorder, since, until), 30);
});

/**
 * Per-circuit daily kWh history for the CircuitModal's multi-day comparison.
 * Returns the last `days` (default 7, max 30) of trapezoidal kWh + peak watt +
 * peak timestamp + coverage, plus a summary block (avg, peak day, min day).
 *
 * v0.9.8 — accepts `?pair=N` as an alternative to `?ch=N`. When `pair` is set,
 * the response integrates the combined `pair${N}_w` series (both legs of a
 * split-phase circuit), so clicking on something like the Pool Pump shows the
 * full 240 V load instead of just one leg's ~half.
 */
app.get<{ Querystring: { sn?: string; ch?: string; pair?: string; days?: string } }>(
  '/api/circuit/history',
  async (req, reply) => {
    const { sn, ch, pair, days } = req.query;
    if (!sn || (!ch && !pair)) {
      reply.code(400);
      return { error: 'sn and (ch or pair) required' };
    }
    const raw = pair ?? ch!;
    const chNum = Number(raw);
    if (!Number.isInteger(chNum) || chNum < 1) {
      reply.code(400);
      return { error: 'ch/pair must be a positive integer' };
    }
    const daysNum = Math.max(1, Math.min(30, Number(days ?? 7) || 7));
    const metric = pair ? `pair${chNum}_w` : undefined;
    return circuitHistoryByDay(recorder, sn, chNum, daysNum, metric);
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

// v0.9.14 — these endpoints all sit downstream of cache-warmer-hot computes,
// so the function call returns instantly. Adding HTTP-level caching (ETag +
// short max-age) saves the JSON-serialization + network cost on repeat fetches
// from the same browser tab.
app.get('/api/forecast', async (req, reply) =>
  cached(req, reply, await getDayForecast(store.get().devices, recorder, (m) => app.log.info(m)), 60),
);

app.get('/api/degradation', async (req, reply) =>
  cached(req, reply, computeDegradation(store.get().devices, recorder), 60),
);

app.get('/api/runway', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return cached(req, reply, computeRunway(store.get().devices, recorder, fc), 30);
});

app.get<{ Querystring: { days?: string } }>('/api/round-trip-efficiency', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, computeRoundTripEfficiency(store.get().devices, recorder, days), 60);
});

app.get('/api/clipping', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return cached(req, reply, computeClipping(store.get().devices, recorder, fc), 60);
});

// v0.7.6 — lifetime energy counters for HA Energy Dashboard.
// Each entry: { persistedWh, pendingWh, watermarkMs } — live total = persistedWh + pendingWh.
// HA expects monotonically-increasing kWh with state_class=total_increasing.
// v0.9.14 — 15 s cache: lifetime counters are recorded server-side every poll;
// 15 s of staleness avoids re-running the JSON build on every HA poll cycle.
app.get('/api/lifetime-energy', async (req, reply) => {
  const totals = recorder.getLifetimeTotals();
  const toKwh = (wh: number) => Math.round((wh / 1000) * 1000) / 1000;
  const live = (k: keyof typeof totals) =>
    toKwh(totals[k].persistedWh + totals[k].pendingWh);
  return cached(req, reply, {
    generated_at: Date.now(),
    pv_lifetime_kwh: live('fleet_pv_wh'),
    load_lifetime_kwh: live('fleet_load_wh'),
    grid_import_lifetime_kwh: live('fleet_grid_import_wh'),
    battery_charge_lifetime_kwh: live('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: live('fleet_battery_discharge_wh'),
    details: totals,
  }, 15);
});

// v0.7.5 — new analytics endpoints (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/self-consumption', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, computeSelfConsumption(store.get().devices, recorder, days), 60);
});

app.get('/api/thermal-events', async (req, reply) =>
  cached(req, reply, computeThermalEvents(store.get().devices, recorder), 60),
);

app.get('/api/equipment-health', async (req, reply) =>
  cached(req, reply, computeEquipmentHealth(store.get().devices, recorder), 60),
);

app.get('/api/shade-report', async (req, reply) =>
  cached(req, reply, computeShadeReport(store.get().devices, recorder), 60),
);

app.get('/api/soiling-decomposition', async (req, reply) =>
  cached(req, reply, await computeSoilingDecomposition(store.get().devices, recorder), 60),
);

app.get('/api/string-mismatch', async (req, reply) =>
  cached(req, reply, computeStringMismatch(store.get().devices, recorder), 60),
);

app.get('/api/ev-window-prediction', async (req, reply) =>
  cached(req, reply, computeEvWindowPrediction(store.get().devices, recorder), 60),
);

app.get('/api/charge-curve', async (req, reply) =>
  cached(req, reply, computeChargeCurveFingerprint(store.get().devices, recorder), 60),
);

app.get('/api/internal-resistance', async (req, reply) =>
  cached(req, reply, computeInternalResistance(store.get().devices, recorder), 60),
);

app.get<{ Querystring: { days?: string } }>('/api/forecast-skill', async (req, reply) => {
  const days = Math.max(1, Math.min(14, Number(req.query.days ?? 7) || 7));
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return cached(req, reply, await computeForecastSkill(store.get().devices, recorder, fc, days), 60);
});

app.get('/api/ambient-thermal-forecast', async (req, reply) =>
  cached(req, reply, await computeAmbientThermalForecast(store.get().devices, recorder), 60),
);

app.get('/api/confidence', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const deg = computeDegradation(store.get().devices, recorder);
  const thermal = await computeAmbientThermalForecast(store.get().devices, recorder);
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return cached(req, reply, computeConfidenceSnapshot(deg, fc, thermal, skill), 60);
});

app.get('/api/nws-alerts', async (req, reply) =>
  cached(req, reply, { alerts: await getActiveNwsAlerts() }, 60),
);

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

app.get('/api/incidents', async (req, reply) =>
  cached(req, reply, { incidents: monitor.incidents() }, 15),
);

app.get('/api/alert-telemetry', async (req, reply) =>
  cached(req, reply, { telemetry: monitor.telemetry() }, 30),
);

/* ─── v0.9.10 — WRITE-side actions ─────────────────────────────────────
 *
 * Cloud-presence refresh for SHP2. Replaces the v0.9.6 reboot button —
 * empirical probing (scripts/probe-shp2-reboot-direct.ts) proved SHP2
 * reboot isn't exposed in the public IoT API. The cheapest documented
 * action that round-trips through EcoFlow's cloud is a no-op write
 * (re-send the current backupReserveSoc), which is enough to un-stick
 * the "zombie online" state the reboot was originally meant to address.
 * Every write is rate-limited + audit-logged.
 */
app.post<{ Params: { sn: string } }>('/api/device/refresh-cloud/:sn', async (req, reply) => {
  const sn = req.params.sn;
  if (!sn || !store.get().devices[sn]) {
    reply.code(404);
    return { error: 'unknown sn' };
  }
  // Pull the current backupReserveSoc from the SHP2 projection — we round-trip
  // this exact value so the write is a true no-op (no state change on the panel).
  const proj = store.get().devices[sn]?.projection;
  const currentReserveSoc =
    proj && proj.kind === 'shp2' ? proj.backupReserveSoc : null;
  if (currentReserveSoc == null) {
    reply.code(409);
    return {
      ok: false,
      code: 'no-snapshot',
      message:
        'No current backupReserveSoc available for this device. Wait for the next polling cycle and retry.',
    };
  }
  const result = await refreshShp2CloudPresence({
    sn,
    currentReserveSoc,
    source: {
      ip: req.ip,
      ua: req.headers['user-agent']?.toString(),
    },
  });
  if (result.outcome !== 'success') reply.code(result.rateLimited ? 429 : 502);
  return {
    ok: result.outcome === 'success',
    code: result.code,
    message: result.message,
    durationMs: result.durationMs,
    rateLimited: !!result.rateLimited,
    cooldownRemainingMs: cooldownRemainingMs('refresh-cloud', sn, REFRESH_COOLDOWN_MS),
  };
});

/** Read-only view of write cooldowns so the UI can disable buttons until ready. */
app.get<{ Querystring: { sn?: string } }>('/api/device/refresh-cloud-cooldown', async (req) => {
  const sn = req.query.sn;
  if (!sn) return { error: 'sn required' };
  return {
    sn,
    cooldownMs: REFRESH_COOLDOWN_MS,
    remainingMs: cooldownRemainingMs('refresh-cloud', sn, REFRESH_COOLDOWN_MS),
  };
});

/** Debug surface for empirically discovering undocumented EcoFlow commands.
 *  Off unless WRITE_DEBUG_TOKEN is set; requires the token in the
 *  `x-write-debug-token` header. Audit-logged like any other write. */
app.post<{ Body: { sn?: string; body?: Record<string, unknown> } }>(
  '/api/device/send-command',
  async (req, reply) => {
    if (!isWriteDebugEnabled()) {
      reply.code(403);
      return { error: 'write-debug disabled (set WRITE_DEBUG_TOKEN env to enable)' };
    }
    const provided = req.headers['x-write-debug-token']?.toString();
    if (!checkWriteDebugToken(provided)) {
      reply.code(401);
      return { error: 'invalid or missing x-write-debug-token header' };
    }
    const body = req.body;
    if (!body || !body.sn || typeof body.body !== 'object') {
      reply.code(400);
      return { error: 'expected { sn, body: { cmdSet, cmdId, params } }' };
    }
    if (!store.get().devices[body.sn]) {
      reply.code(404);
      return { error: 'unknown sn' };
    }
    const result = await debugSendCommand({
      sn: body.sn,
      body: body.body,
      source: {
        ip: req.ip,
        ua: req.headers['user-agent']?.toString(),
      },
    });
    if (result.outcome !== 'success') reply.code(502);
    return result;
  },
);

/** Last N audit-log entries. Useful for the UI to show "last writes". */
app.get<{ Querystring: { limit?: string } }>('/api/writes/log', async (req) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50) || 50));
  return { entries: tailWriteLog(limit) };
});

// v0.8.0 — sustainability, tariff, probabilistic forecasts, multi-day,
// dispatch planner, calendar, repair issues (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/carbon', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, computeCarbonReport(store.get().devices, recorder, days), 60);
});

app.get<{ Querystring: { days?: string } }>('/api/tariff', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, computeTariffReport(store.get().devices, recorder, days), 60);
});

app.get('/api/forecast/probabilistic', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return cached(req, reply, computeProbabilisticForecast(fc, skill), 60);
});

app.get<{ Querystring: { days?: string } }>('/api/forecast/multi-day', async (req, reply) => {
  const days = Math.max(1, Math.min(7, Number(req.query.days ?? 3) || 3));
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return cached(req, reply, computeMultiDayForecast(store.get().devices, recorder, fc, days), 60);
});

app.get('/api/dispatch-plan', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  return cached(req, reply, computeDispatchPlan(store.get().devices, fc), 60);
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

// v0.9.0 — Bayesian solar model + Pack Risk Scores (cached v0.9.14)
app.get('/api/forecast/bayesian', async (req, reply) =>
  cached(req, reply, computeBayesianSolarModel(store.get().devices, recorder), 60),
);

app.get('/api/pack-risk', async (req, reply) => {
  const deg = computeDegradation(store.get().devices, recorder);
  const therm = computeThermalEvents(store.get().devices, recorder);
  const ir = computeInternalResistance(store.get().devices, recorder);
  const cc = computeChargeCurveFingerprint(store.get().devices, recorder);
  return cached(req, reply, computePackRiskScores(store.get().devices, deg, therm, ir, cc), 60);
});

// v0.9.4 — trained ML risk scoring. Surfaces three side-by-side signals
// per pack: heuristic (v0.9.0), trained logistic regression, unsupervised
// novelty. Composite = mean of the three. modelVersion is honest about
// whether real labels exist (lr-labeled-v1) vs heuristic-distilled
// (lr-heuristic-baseline-v1). When real failures accumulate, drop a CSV
// into data/labels.csv and run `npm run train-pack-risk`.
app.get('/api/pack-risk/v2', async (req, reply) => {
  const deg = computeDegradation(store.get().devices, recorder);
  const therm = computeThermalEvents(store.get().devices, recorder);
  const ir = computeInternalResistance(store.get().devices, recorder);
  const cc = computeChargeCurveFingerprint(store.get().devices, recorder);
  const heur = computePackRiskScores(store.get().devices, deg, therm, ir, cc);
  return cached(req, reply, computePackRiskV2(store.get().devices, heur.packs, deg, therm, ir, cc), 60);
});

app.get('/api/repair-issues', async (req, reply) => {
  const fc = await getDayForecast(store.get().devices, recorder, () => {});
  const skill = await computeForecastSkill(store.get().devices, recorder, fc);
  return cached(req, reply, computeRepairIssues({
    devices: store.get().devices,
    alerts: store.get().alerts ?? [],
    degradation: computeDegradation(store.get().devices, recorder),
    soiling: await computeSoilingDecomposition(store.get().devices, recorder),
    equipmentHealth: computeEquipmentHealth(store.get().devices, recorder),
    forecastSkill: skill,
  }), 60);
});

/**
 * Flat key-value snapshot for Home Assistant REST sensors. One HTTP call
 * returns every metric we expose as an HA entity (`configuration.yaml`
 * snippet is in DOCS.md). Cached forecast + degradation are reused, so
 * HA can poll this every 30s without hammering the recorder.
 */
app.get('/api/ha-state', async (req, reply) => {
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

  const payload = {
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
  // v0.9.14 — 25 s cache: the underlying computes refresh every 4 min via the
  // cache warmer, but HA polls this every 30 s. ETag + 25 s max-age means most
  // HA polls return 304 with no body — saves ~3 KB JSON per HA entity-poll cycle.
  return cached(req, reply, payload, 25);
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

app.get('/api/alerts/history', async (req, reply) =>
  cached(req, reply, { cleared: monitor.history() }, 30),
);

/* v0.9.25 — feedback-loop endpoints.
 *
 *   POST /api/alerts/outcome   submit operator verdict on an alert
 *   GET  /api/alerts/outcomes  recent submissions (debug + audit)
 *   GET  /api/alerts/outcomes/stats   per-family precision + counts
 *
 * No auth on these — same security model as the rest of the panel
 * (lives behind HA Ingress or the LAN-only port). The submitting
 * operator's IP + UA are recorded for audit. */
app.post<{ Body: { alertId?: string; outcome?: string; notes?: string } }>(
  '/api/alerts/outcome',
  async (req, reply) => {
    const { alertId, outcome, notes } = req.body ?? {};
    if (!alertId || typeof alertId !== 'string') {
      reply.code(400);
      return { ok: false, error: 'alertId required' };
    }
    if (!outcome || !['ack', 'dismiss', 'failed', 'resolved'].includes(outcome)) {
      reply.code(400);
      return { ok: false, error: 'outcome must be one of: ack, dismiss, failed, resolved' };
    }
    // Find the live alert (for category/severity context) — might not exist
    // if the alert has since cleared, which is fine; we still record.
    const liveAlert = (store.get().alerts ?? []).find((a) => a.id === alertId);
    const snap = getSnapshot(alertId);
    appendAlertOutcome({
      ts: Date.now(),
      alertId,
      category: liveAlert?.category ?? snap?.category,
      severity: liveAlert?.severity ?? snap?.severity,
      outcome: outcome as AlertOutcome,
      notes: notes && typeof notes === 'string' ? notes.slice(0, 500) : undefined,
      features: snap?.features,
      alertFiredAt: snap?.ts,
      source: {
        ip: req.ip,
        ua: req.headers['user-agent']?.toString(),
      },
    });
    // Outcome captured — drop the feature snapshot to free memory.
    // (The persisted JSONL keeps it for any future bulk re-training.)
    dropSnapshot(alertId);
    return { ok: true };
  },
);

app.get<{ Querystring: { limit?: string } }>(
  '/api/alerts/outcomes',
  async (req, reply) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50) || 50));
    return cached(req, reply, { entries: tailAlertOutcomes(limit) }, 15);
  },
);

app.get('/api/alerts/outcomes/stats', async (req, reply) =>
  cached(req, reply, { families: computeFamilyStats() }, 60),
);

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

// v0.9.5 — cache pre-warmer. Runs the heavy /api/ha-state computations
// every 4 min so request-path callers always hit warm caches (was: every
// 5 min the next /api/ha-state caller paid ~1.8s rebuilding everything).
const cacheWarmer = startCacheWarmer(store, recorder, (m) => app.log.info(m));

// v0.9.18 — Ship-wide audible broadcast. Listens for alert-condition
// transitions (green/yellow/red) and pushes Starfleet klaxon WAVs to
// configured HomePod / Sonos media_player entities via HA service calls.
// Off unless BROADCAST_ENABLED=true and at least one target is set.
const broadcast = startBroadcastMonitor(store, (m) => app.log.info(m));

// Diagnostics: per-task warm timings + alert-monitor stats.
app.get('/api/cache-warmer/status', async () => ({
  timings: cacheWarmer.lastTimings(),
}));

/* v0.9.18 — broadcast diagnostic + manual test endpoints.
 *
 * GET  /api/broadcast/status — current config snapshot + last broadcast
 * POST /api/broadcast/test   — fire a test broadcast (bypasses all gates)
 *   body: { level?: "red" | "yellow" | "green" }   (default "red")
 */
app.get('/api/broadcast/status', async () => {
  const s = broadcast.status();
  const cfg = broadcast.config();
  return {
    ...s,
    config: {
      enabled: cfg.enabled,
      targets: cfg.targets,
      audioBase: cfg.audioBase,
      volume: cfg.volume,
      minSeverity: cfg.minSeverity,
      quietHours: cfg.quietHours,
      ttsService: cfg.ttsService,
      sonosRestore: cfg.sonosRestore,
      backend: cfg.backend,
    },
  };
});

app.post<{ Body: { level?: 'red' | 'yellow' | 'green' } }>(
  '/api/broadcast/test',
  async (req, reply) => {
    const level = req.body?.level ?? 'red';
    if (!['red', 'yellow', 'green'].includes(level)) {
      reply.code(400);
      return { ok: false, error: 'level must be red, yellow, or green' };
    }
    const r = await broadcast.test(level);
    // v0.9.23 — 429 when blocked by cooldown, 502 on real failures, 200 ok.
    if (!r.ok) {
      const isCooldown = r.cooldownRemainingMs != null && r.cooldownRemainingMs > 0 && r.messages.some((m) => m.startsWith('cooldown:'));
      reply.code(isCooldown ? 429 : 502);
    }
    return r;
  },
);

/**
 * v0.9.19 — discover every media_player entity HA knows about so the
 * user can pick targets from a real list instead of guessing entity IDs.
 * We use the manufacturer + model hints HA exposes to label HomePods vs
 * Sonos vs Apple TV vs generic Cast vs Echo, so the user sees what each
 * speaker actually is.
 *
 * Returns:
 *   {
 *     supervised: boolean,
 *     count: number,
 *     speakers: [
 *       { entity_id, friendly_name, family: 'sonos'|'homepod'|'cast'|'echo'|'androidtv'|'apple_tv'|'unknown',
 *         state, volume_level, source, currently_configured: boolean }
 *     ]
 *   }
 */
app.get('/api/broadcast/discover', async (_req, reply) => {
  const cfg = broadcast.config();
  const all = await getAllStates();
  if (!all) {
    reply.code(503);
    return { supervised: false, count: 0, speakers: [], error: 'SUPERVISOR_TOKEN missing or HA unreachable' };
  }
  const configured = new Set(cfg.targets);
  const speakers = all
    .filter((s) => s.entity_id.startsWith('media_player.'))
    .map((s) => {
      const a = s.attributes ?? {};
      const friendly = String(a.friendly_name ?? s.entity_id.replace(/^media_player\./, ''));
      const family = familyOf(s.entity_id, a);
      return {
        entity_id: s.entity_id,
        friendly_name: friendly,
        family,
        state: s.state,
        volume_level: typeof a.volume_level === 'number' ? a.volume_level : null,
        source: typeof a.source === 'string' ? a.source : null,
        currently_configured: configured.has(s.entity_id),
      };
    })
    .sort((a, b) => {
      // Configured first, then group by family, then alphabetical.
      if (a.currently_configured !== b.currently_configured) {
        return a.currently_configured ? -1 : 1;
      }
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      return a.friendly_name.localeCompare(b.friendly_name);
    });
  return { supervised: true, count: speakers.length, speakers };
});

/** Infer the speaker family from the entity_id + attributes — drives the
 * type column + decides which broadcast helpers (sonos.snapshot etc.) apply. */
function familyOf(entityId: string, attrs: Record<string, unknown>): string {
  const id = entityId.toLowerCase();
  const platform = String(attrs.platform ?? '').toLowerCase();
  const sourceList = Array.isArray(attrs.source_list) ? attrs.source_list.join(' ').toLowerCase() : '';
  const dt = String((attrs as any).device_class ?? '').toLowerCase();
  if (id.includes('sonos') || platform === 'sonos' || sourceList.includes('sonos')) return 'sonos';
  if (id.includes('homepod') || platform === 'homepod' || /homepod/i.test(String((attrs as any).model ?? ''))) return 'homepod';
  if (platform === 'apple_tv' || id.includes('apple_tv')) return 'apple_tv';
  if (platform === 'cast' || id.includes('chromecast') || id.includes('cast') || dt === 'speaker') return 'cast';
  if (platform === 'alexa_media' || id.includes('echo') || id.includes('alexa')) return 'echo';
  if (platform === 'androidtv' || id.includes('android_tv') || id.includes('androidtv')) return 'androidtv';
  return 'unknown';
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
  cacheWarmer.stop();
  broadcast.stop();
  recorder.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
