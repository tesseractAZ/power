import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { SnapshotStore, startPollLoop } from './snapshot.js';
import { startMqtt } from './ecoflow/mqtt.js';
import { createRecorder } from './recorder.js';
import { computeTotals, startOfLocalDayMs } from './aggregator.js';
import { startAlertMonitor } from './alertMonitor.js';
import { isConfigured } from './notify.js';
import { getDayForecast, computeDegradation } from './analytics.js';
import { startTelnetServer } from './telnet/server.js';

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

await app.listen({ host: config.host, port: config.port });
app.log.info(`EcoFlow panel API listening on http://${config.host}:${config.port}`);

const shutdown = async () => {
  app.log.info('shutting down');
  stopPoll();
  stopMqtt?.();
  monitor.stop();
  stopTelnet?.();
  recorder.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
