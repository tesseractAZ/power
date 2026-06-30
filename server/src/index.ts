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
import { createAuth, isAllowedOrigin } from './auth.js';
import { SnapshotStore, startPollLoop } from './snapshot.js';
import type { FleetSnapshot } from './snapshot.js';
import { shp2ConnectedDpuSns, isShp2Connected, isSourceDpuStale, aggregateFleetFlow, findShp2, onlineDpus } from './shp2Membership.js';
import { startMqtt } from './ecoflow/mqtt.js';
import { createRecorder } from './recorder.js';
import { kwh1, makeLifetimeKwh, makeAlertCounter, soonestProjecting } from './haPayloadFmt.js';
import { startOfLocalDayMs } from './aggregator.js';
import { startAlertMonitor } from './alertMonitor.js';
import { isConfigured } from './notify.js';
// v0.9.18 — ship-wide audible broadcast to HomePod/Sonos via HA media_player.
import { generateAudioAssets, BUILTIN_TONES } from './audioAssets.js';
import { startBroadcastMonitor } from './broadcast.js';
import { getAllStates, getEntityState } from './haService.js';
// v0.9.33 — Supervisor add-on + Core config-flow helpers
import {
  listAddons,
  listConfigEntries,
  startConfigFlow,
  submitConfigFlow,
  deleteConfigEntry,
} from './haService.js';
// v0.9.25 — feedback-loop foundation
import { appendAlertOutcome, tailAlertOutcomes, computeFamilyStats, type AlertOutcome } from './alertOutcomes.js';
import { getSnapshot, dropSnapshot } from './featureSnapshot.js';
// v0.9.27 — multi-track model advance
import { updateFromOutcome } from './models/onlineLR.js';
import { computeModelHealth } from './models/modelHealth.js';
import { physicsPmax, physicsScore, PHOENIX_SITE } from './physics/clearSky.js';
import { analyzePackLfp } from './physics/lfpOcv.js';
import { fitHierarchical, findOutliers, type HBPackObs } from './models/hierarchicalBayes.js';
import { recommendDispatch, type MpcInputs } from './dispatch/mpc.js';
import {
  // v0.10.0 — recorder-backed compute* moved to the analytics worker
  // (see analyticsClient.report). Only the PURE assemblers that take
  // already-computed inputs and no recorder stay imported here; they run
  // cheaply on the main thread over worker-fetched report data.
  computeConfidenceSnapshot,
  getActiveNwsAlerts,
  computeDispatchPlan,
  rootCausesFor,
  computePackRiskScores,
  runwayHoursForPublish,
} from './analytics.js';
import { startTelnetServer } from './telnet/server.js';
import { createTuiDataProvider } from './telnet/dataProvider.js';
import { registerWsConsole } from './telnet/wsConsole.js';
import { startMqttDiscovery } from './mqttDiscovery.js';
import { buildCalendarIcs } from './calendar.js';
import { computeRepairIssues } from './repairIssues.js';
import { getWeather } from './weather.js';
import type { WeatherForecast } from './weather.js';
import { computePackRiskV2 } from './ml.js';
import { initAnalyticsClient } from './analyticsClient.js';
import {
  refreshShp2CloudPresence,
  debugSendCommand,
  isWriteDebugEnabled,
  checkWriteDebugToken,
  cooldownRemainingMs,
  REFRESH_COOLDOWN_MS,
} from './ecoflow/commands.js';
import { appendWriteLog, tailWriteLog } from './writeLog.js';
// v0.11.0 — ISA-18.2 / IEC 62682 alarm-priority Alert Settings + preview.
import { getAlertSettings, updateAlertSettings, isPriorityEnabled, DEFAULT_CHIME_REPEAT } from './alertSettings.js';
import { getBroadcastRuntimeConfig, updateBroadcastRuntimeConfig } from './broadcastRuntimeConfig.js';
// v0.15.23 — Alert Console: operator-uploaded chime tones + per-level assignment.
import {
  CHIMES_DIR, MAX_UPLOAD_BYTES, listChimes, saveChime, deleteChime,
} from './chimeStore.js';
import {
  getChimeConfig, updateChimeConfig, revertAssignmentsFor, CHIME_LEVELS,
  type ChimeAssignment,
} from './chimeConfig.js';
import type { AnnouncementLevel } from './audioRenderer.js';
import { ALARM_PRIORITY_ORDER, ALARM_PRIORITY_META, type AlarmPriority } from './alertPriority.js';
// v0.12.0 — backup-pool SoC audible alarm (escalating priority).
import { createBatterySocAlarm, socAlarmMessage, socAlarmMessageEs, socAlarmAdvisoryEs } from './batterySocAlarm.js';
import { createRunwayAlarm } from './runwayAlarm.js';
import { liveGridBackstop, gridPresenceEntityId } from './gridState.js';
import { socGridCrossDecision, reEscalateGridDrop } from './socGridDispatch.js';
import { classifyMqttStartFailure } from './mqttStartClassify.js';
import {
  hasReachabilityConfig,
  deviceReachabilityEntities,
  setDeviceReachability,
  interpretReachabilityState,
  countCloudWedges,
} from './deviceLink.js';
import { installProcessGuards } from './processGuard.js';
import { createLoadShedAdvisor } from './loadShedAdvisor.js';
import { getShedCandidates, initShedRegistry } from './loadShedRegistry.js';
import * as haStateCache from './haStateCache.js';

// REST polling cadence. MQTT now delivers per-cmdId fresh data, but we keep a
// 60s REST poll as a baseline for fields that MQTT doesn't emit and as recovery
// after broker disconnects.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

// v0.15.18 — log diet. Per-request logging was 78 % of journald volume
// (~31k lines / 50 h: 'incoming request' + 'request completed' for every
// dashboard/HACS-card poll), drowning the lines that matter. Request logging
// is off; an onResponse hook below logs server errors (≥500) at warn, client
// 4xx at debug, slow >1s at info. The pino logMethod hook drops fastify's INFO 'stream closed
// prematurely' (media players aborting WAV range-requests — 3-4 per
// successful broadcast, fastify/lib/reply.js, benign by definition).
const app = Fastify({
  disableRequestLogging: true,
  logger: {
    level: config.logLevel,
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        for (const a of args) {
          if (typeof a === 'string' && a.includes('stream closed prematurely')) return;
        }
        method.apply(this, args as never);
      },
    },
  },
});
app.addHook('onResponse', (req, reply, done) => {
  const ms = Math.round((reply as { elapsedTime?: number }).elapsedTime ?? 0);
  if (reply.statusCode >= 500) {
    req.log.warn({ url: req.url, statusCode: reply.statusCode, ms }, 'request error');
  } else if (reply.statusCode >= 400) {
    req.log.debug({ url: req.url, statusCode: reply.statusCode, ms }, 'request rejected');
  } else if (ms > 1000) {
    req.log.info({ url: req.url, statusCode: reply.statusCode, ms }, 'slow request');
  }
  done();
});
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
// v0.15.23 — Alert Console chime upload. Accept the raw WAV bytes as the request
// body (no @fastify/multipart dependency — keeps the add-on offline-lean). The
// per-parser bodyLimit caps memory; chimeStore re-validates + normalizes. The
// display filename rides in the ?name= query string, NEVER in a path. A
// dedicated content type keeps this parser off the JSON path entirely.
app.addContentTypeParser(
  ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream'],
  { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
  (_req, body, done) => done(null, body),
);
/* ─── v0.9.62 — defense-in-depth security hardening ──────────────────
 *
 * the operator's add-on lives on a trusted LAN behind HA Ingress, so today no
 * one is going to drive-by-attack it. But a defense-in-depth audit
 * surfaced three risks worth closing:
 *
 *   1. CORS was `origin: true` (echoes any Origin), which means any
 *      malicious page on the LAN could fire `fetch('http://.../api/...',
 *      { credentials: 'include' })` and read the panel's state — or
 *      worse, fire writes. We replace it with an explicit allow-list of
 *      same-origin + HA dashboard origins + LAN HA host patterns.
 *   2. Write endpoints were unauthenticated. We add a write-token +
 *      same-origin + HA-ingress allowlist (`requireWriteAuth`). The
 *      token is auto-generated on first start and stored mode-0600 at
 *      `/data/panel-write-token.txt`, so the operator (the operator) can read
 *      it once and embed it in cross-origin scripts.
 *   3. Admin / Supervisor-facing GETs (audit log, addon listing,
 *      media-player discovery) were unauthenticated. We layer the same
 *      `requireWriteAuth` hook on them.
 *
 * NORMAL OPERATION IS UNCHANGED:
 *   - The React dashboard at port 8787 is same-origin → passes.
 *   - HA Ingress requests carry `X-Ingress-Path` → passes.
 *   - Lovelace cards do read-only GETs to /api/snapshot etc. → not gated.
 *   - `/api/alerts/outcome` is intentionally left open (user-feedback).
 */

/**
 * v0.9.60 — Write-auth gate (extracted to ./auth.ts for unit-testability).
 *
 * `createAuth` builds the same-origin allow-list, runs the token-bootstrap
 * I/O, and returns the Fastify preHandler used by every gated route.
 * Behavior identical to the pre-extract inlined block; see auth.ts for
 * the full per-condition rationale.
 */
const auth = createAuth({
  host: config.host,
  port: config.port,
  log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
});
const WRITE_TOKEN_PATH = auth.tokenPath;
const requireWriteAuth = auth.requireWriteAuth;

/**
 * v0.16.1 — minimal in-process fixed-window rate limiter (no dependency).
 * Applied AFTER requireWriteAuth on the filesystem-touching write endpoints
 * (chime upload/delete/config). These are operator-only (ingress/same-origin)
 * and already bounded by chimeStore's 2 MB / 20-file caps, but a fixed cap also
 * bounds CPU (WAV normalization) and disk churn if a compromised same-origin
 * session floods them — and addresses CodeQL js/missing-rate-limiting. Shared
 * bucket across the chime write routes; 30 writes/minute is ample for a human.
 */
function makeRateLimiter(maxPerWindow: number, windowMs: number) {
  let windowStart = 0;
  let count = 0;
  return (
    _req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    done: (err?: Error) => void,
  ): void => {
    const now = Date.now();
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    count += 1;
    if (count > maxPerWindow) {
      reply.code(429).send({ ok: false, error: 'rate limited — too many writes, slow down' });
      return; // reply sent; do NOT call done() (request is handled)
    }
    done();
  };
}
const chimeWriteRateLimit = makeRateLimiter(30, 60_000);

await app.register(cors, {
  // Callback form: same-origin requests (no Origin header) get echoed
  // through unchanged; cross-origin requests are accepted only if the
  // Origin matches our allowlist. Anything else gets NO
  // Access-Control-Allow-Origin header, so the browser blocks the
  // response from JS.
  origin: auth.corsOriginCallback,
});
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
    // v0.68.0 — bound inbound ws frames. The /ws snapshot socket and the
    // /console/ws terminal only ever receive tiny client frames (keystrokes,
    // a small resize JSON; /ws receives nothing), so 64 KiB is generous while
    // capping a malicious/runaway client's per-frame memory.
    maxPayload: 64 * 1024,
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
 *
 * v0.9.27 — fixed Fastify lifecycle bug. When ETag matched, the code
 * called `reply.code(304).send()` AND returned `body`. Fastify then
 * tried to serialize + send `body` onto the already-closed stream,
 * producing 223+ "Reply was already sent" warnings in 2 hours of
 * normal traffic across 17 endpoints (every endpoint that uses this
 * helper). Fix: return `reply` itself when we manually send — Fastify
 * recognizes a returned FastifyReply as "already handled, skip
 * serialization". Cast through `unknown as T` because every call site
 * just hands the return value back to Fastify; nobody inspects it.
 */
function cached<T>(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, body: T, maxAgeSec = 30): T {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(json).digest('base64').slice(0, 22)}"`;
  reply.header('Cache-Control', `private, max-age=${maxAgeSec}`);
  reply.header('ETag', etag);
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    // v0.9.27 — return the reply itself so Fastify treats this as
    // already-handled and skips its own serialization step. The previous
    // `return body` triggered the "Reply was already sent" warning storm.
    return reply.code(304).send() as unknown as T;
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
  // Asset prefixes served by fastify-static plugins below. A GET that misses a
  // real file under one of these must hard-404 — falling through to the SPA
  // catch-all would return index.html (HTML 200) for a missing tone, masking a
  // broken assignment as a silent success in the Alert Console preview.
  const ASSET_404_PREFIXES = ['/chimes/', '/audio-render/', '/audio/'];
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method !== 'GET' ||
      req.url.startsWith('/api/') ||
      req.url.startsWith('/ws') ||
      ASSET_404_PREFIXES.some((p) => req.url.startsWith(p))
    ) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
  app.log.info(`web: serving built UI from ${webDist}`);
} else {
  app.log.info(`web: no built bundle at ${webDist} (dev mode — Vite at :5173)`);
}

// v0.9.18 — synthesise the alert klaxon WAVs at startup and serve them
// at /audio/*. HomePod / Sonos stream these URLs when we broadcast
// condition transitions through Music Assistant.
const audioDir = resolve(process.env.DATA_DIR ?? '/data', 'audio');
await generateAudioAssets(audioDir, (m) => app.log.info(m));
await app.register(fastifyStatic, {
  root: audioDir,
  prefix: '/audio/',
  decorateReply: false,
  wildcard: false,
});

// v0.9.70 — combined klaxon + TTS announcements are rendered on demand
// into a separate cache dir. Served at /audio-render/* so the WAVs the
// renderer creates are distinct from the per-level klaxon files (which
// the renderer reads as inputs).
//
// v0.9.71 — fastify-static refuses to register the route when `root`
// doesn't exist at registration time. mkdirSync up-front so the route
// is always wired even before the first render writes anything.
//
// v0.9.73 — wildcard MUST be true here (unlike /audio/* above).
// fastify-static's wildcard:false mode ENUMERATES files at registration
// time and registers an explicit route per file. New files written at
// runtime aren't visible. That's fine for /audio/ (klaxons generated at
// startup, set in stone after), but FATAL for /audio-render/ where the
// whole point is rendering files on demand. v0.9.70-v0.9.72 all 404'd
// every newly-rendered announcement — the only files that served were
// ones that happened to already exist on disk before startup. Yellow
// "worked" only because it was rendered under v0.9.70 and survived to
// v0.9.71 startup, when wildcard:false enumerated it. Red rendered
// fresh under v0.9.72 was invisible. wildcard:true does on-demand path
// resolution per request — the correct mode for a dynamic cache dir.
const audioRenderDir = resolve(process.env.DATA_DIR ?? '/data', 'audio-render');
const { mkdirSync } = await import('node:fs');
mkdirSync(audioRenderDir, { recursive: true });
await app.register(fastifyStatic, {
  root: audioRenderDir,
  prefix: '/audio-render/',
  decorateReply: false,
  wildcard: true,
});

// v0.15.23 — Alert Console: serve operator-uploaded chime tones for IN-BROWSER
// preview at /chimes/<id>.wav. Same shape as /audio-render/: decorateReply
// FALSE (only the first static register may own reply.sendFile) and wildcard
// TRUE (tones are written at runtime; wildcard:false enumerates at registration
// and 404s new files until restart — the exact /audio-render pitfall above).
// mkdirSync up-front so fastify-static registers even before the first upload.
mkdirSync(CHIMES_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: CHIMES_DIR,
  prefix: '/chimes/',
  decorateReply: false,
  wildcard: true,
});

// v0.9.55 — serve the HACS Lovelace card bundles directly from the
// add-on at `/lovelace/<card>.js`, so a HA dashboard can reference them
// as Lovelace resources without HACS being installed. The `@fastify/cors`
// register on line 112 already passes `origin: true`, so a dashboard
// hosted at :8123 can do `import('http://host:8787/lovelace/foo.js')`
// without the browser blocking the module fetch.
//
// In production (the add-on image) the Dockerfile copies
// `lovelace/dist/` to `/app/lovelace/dist/`; in local dev the relative
// `../../lovelace/dist` from `server/dist/` resolves the same way.
const lovelaceDist =
  process.env.LOVELACE_DIST_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../lovelace/dist');
if (existsSync(lovelaceDist)) {
  await app.register(fastifyStatic, {
    root: lovelaceDist,
    prefix: '/lovelace/',
    decorateReply: false,
    wildcard: false,
  });
  app.log.info(`lovelace: serving card bundles from ${lovelaceDist}`);
} else {
  app.log.warn(`lovelace: no bundle directory at ${lovelaceDist}`);
}

const store = new SnapshotStore();
/** v0.36.0 — snapshot the dashboard/TUI consume, augmented with the live grid backstop. */
function snapshotForClient(): FleetSnapshot {
  const s = store.get();
  const grid = liveGridBackstop(s.devices);
  const off_grid = !grid.present;
  // Attach the grid backstop onto the SHP2 device too, so device-scoped
  // consumers (Shp2Card) get it directly off `devices[shp2sn]`. IMMUTABLE:
  // shallow-copy the devices map + the one SHP2 device so we never mutate the
  // objects inside store.get() (the HA-state + /api/broadcast/status consumers
  // read raw store.get() and must stay byte-identical).
  const shp2 = findShp2(s.devices);
  // v0.40.1 — annotate each SHP2 source slot with `dpuStale` (the slot is counted
  // by the SHP2 but its underlying DPU is itself cloud-offline). OBSERVABILITY ONLY:
  // does NOT touch backup-pool capacity (SHP2-aggregate, stays authoritative) or the
  // floor alarm. Immutable, so the raw store the HA-state/broadcast paths read is
  // untouched. The TUI computes the same flag inline via isSourceDpuStale.
  const shp2Enriched =
    shp2 && shp2.projection?.kind === 'shp2'
      ? {
          ...shp2,
          grid,
          off_grid,
          projection: {
            ...shp2.projection,
            sources: shp2.projection.sources.map((src) => ({
              ...src,
              dpuStale: isSourceDpuStale(src, s.devices),
            })),
          },
        }
      : shp2
        ? { ...shp2, grid, off_grid }
        : undefined;
  const devices = shp2Enriched ? { ...s.devices, [shp2!.sn]: shp2Enriched } : s.devices;
  return { ...s, devices, grid, off_grid };
}
const recorder = createRecorder(store, (m) => app.log.info(m));
// v0.10.0 — analytics worker. Every heavy history scan (the cache-warmer's
// reports + each /api/* analytics endpoint) runs on the worker's event loop
// against a read-only connection to the same WAL DB. The main thread keeps
// the sole write connection (ingestion + lifetime rollup) and never blocks on
// a multi-second SQLite scan again — which is what was intermittently
// starving the HTTP port and tripping the Supervisor watchdog. The worker
// self-warms its report caches, so the old main-thread cache-warmer is gone.
const analytics = initAnalyticsClient(resolve(process.cwd(), config.dbPath), (m) => app.log.info(m));
store.on('change', (snap) => analytics.pushSnapshot(snap));

app.get('/api/snapshot', async () => snapshotForClient());
app.get('/api/health', async () => ({ ok: true, generatedAt: store.get().generatedAt }));

/**
 * v0.9.74 — unauth version stamp. Quick debug surface to confirm which
 * release a panel is running without having to crack open `/api/snapshot`
 * or read the addon log. Returns the `BUILD_VERSION` env var set by
 * `images.yml` at build time (e.g. "0.9.74"), falling back to "dev" when
 * running outside the Docker image.
 */
app.get('/api/version', async () => ({
  version: process.env.BUILD_VERSION || 'dev',
  builtAt: process.env.BUILD_DATE || null,
  ref: process.env.BUILD_REF || null,
}));

/**
 * v0.9.62 — unauth surface so a (future) UI consumer can detect that
 * writes need an X-Panel-Write-Token (or HA ingress / same-origin) and
 * surface the right hint to the user instead of just hitting a blind
 * 401. Current dashboard doesn't need this (it's same-origin), but
 * external callers (a future companion app, a curl-from-laptop user)
 * will.
 */
app.get('/api/panel-info', async () => ({
  writeAuthRequired: true,
  sameOriginOk: true,
  ingressOk: true,
  tokenHeader: 'X-Panel-Write-Token',
  tokenPath: WRITE_TOKEN_PATH,
}));

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
    const points = await analytics.query(sn, metric, sinceMs, untilMs, bucketSec);
    // v0.9.14 — short Cache-Control + ETag so repeat fetches from the same
    // dashboard tab return 304. History rows are append-only; 15s of staleness
    // on the trailing edge is fine for chart UX.
    return cached(req, reply, { sn, metric, sinceMs, untilMs, bucketSec, points }, 15);
  },
);

app.get<{ Querystring: { since?: string; until?: string } }>('/api/summary/today', async (req, reply) => {
  const since = req.query.since ? Number(req.query.since) : startOfLocalDayMs();
  const until = req.query.until ? Number(req.query.until) : Date.now();
  return cached(req, reply, await analytics.report('totals', { sinceMs: since, untilMs: until }), 30);
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
    return await analytics.report('circuitHistory', { sn, ch: chNum, days: daysNum, metric });
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
  return { sn, metrics: await analytics.listMetrics(sn) };
});

// v0.9.14 — these endpoints all sit downstream of cache-warmer-hot computes,
// so the function call returns instantly. Adding HTTP-level caching (ETag +
// short max-age) saves the JSON-serialization + network cost on repeat fetches
// from the same browser tab.
app.get('/api/forecast', async (req, reply) =>
  cached(req, reply, await analytics.report('forecast'), 60),
);

app.get('/api/degradation', async (req, reply) =>
  cached(req, reply, await analytics.report('degradation'), 60),
);

app.get('/api/runway', async (req, reply) =>
  cached(req, reply, await analytics.report('runway'), 30),
);

app.get<{ Querystring: { days?: string } }>('/api/round-trip-efficiency', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('roundTripEfficiency', { days }), 60);
});

app.get('/api/clipping', async (req, reply) =>
  cached(req, reply, await analytics.report('clipping'), 60),
);

// v0.9.77 — SoC-saturation curtailment (distinct from inverter clipping).
// Surfaces "PV being rejected at the panels because batteries are full".
// The engine handles its own 1-min cache; this Fastify wrapper adds the
// standard hash-etag + 60s Cache-Control treatment used by every other
// analytics endpoint, so dashboards re-poll without re-shipping bytes.
app.get('/api/curtailment', async (req, reply) =>
  cached(req, reply, await analytics.report('curtailment'), 60),
);

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
    // v0.34.0 — total whole-home grid import metered at the SHP2 main. The
    // grid_import figure above counts only grid that charged the DPUs; this is the
    // authoritative total (accumulates from deploy — there is no historical back-fill).
    grid_to_home_lifetime_kwh: live('fleet_grid_home_wh'),
    battery_charge_lifetime_kwh: live('fleet_battery_charge_wh'),
    battery_discharge_lifetime_kwh: live('fleet_battery_discharge_wh'),
    // v0.56.0 — DISPLAY-ONLY annotation (does NOT touch the total_increasing counters). The coulomb
    // baseline was captured mid-life, so over a window ending below baseline SoC cumulative discharge
    // legitimately EXCEEDS charge (energy stored before the baseline counts on the way out but was
    // never counted as charge in-window). This is NOT an RTE>100% energy-conservation violation —
    // the user-facing round-trip efficiency is computed separately and clamped ≤100%. Positive =
    // discharge ahead of charge; shrinks toward zero as the pool returns to its baseline SoC.
    // See /api/debug/battery-lifetime.deficitWh.
    battery_baseline_deficit_kwh:
      Math.round((live('fleet_battery_discharge_wh') - live('fleet_battery_charge_wh')) * 1000) / 1000,
    details: totals,
  }, 15);
});

// v0.45.0 — read-only diagnostics for the lifetime battery counters. Surfaces
// the unclamped charge/discharge floors, the emitted totals (persisted+pending
// split), the informational deficit the removed discharge≤charge clamp would
// have shaved, the per-pack filter/held breakdown, and which SHP2 members are
// being carried while offline. STRICTLY READ-ONLY (zero writes / zero mutation
// of the emitted counters) — see recorder.batteryLifetimeDebug.
app.get('/api/debug/battery-lifetime', async (req, reply) => {
  return cached(req, reply, {
    generated_at: Date.now(),
    ...recorder.batteryLifetimeDebug(),
  }, 15);
});

// v0.54.1 — read-only soiling diagnostics. Surfaces computeSoiling's full
// per-day clear-sky coeff distribution (dayCoeffs/dayHours), the coverage bar,
// baseline (current max), recentCoeff, recentCovered, cleanDays, and dropPct —
// so a baseline inflated by one outlier "best day" can be told apart from a
// genuinely depressed recent window. STRICTLY READ-ONLY (mirrors the forecast's
// own soiling object; no recompute side effects, no writes).
app.get('/api/debug/soiling', async (req, reply) => {
  const fc = await analytics.report('forecast');
  return cached(req, reply, {
    generated_at: Date.now(),
    soiling: fc.soiling ?? null,
  }, 15);
});

// v0.30.0 — telemetry-gap markers: a durable, queryable record of any home-feed
// blackout the recorder detected (see recorder.detectTelemetryGap). A silent
// upstream stall now shows up as an incident here instead of only being
// discoverable by scanning /api/history for missing buckets.
app.get('/api/telemetry-gaps', async (req, reply) => {
  const gaps = recorder.telemetryGaps();
  return cached(req, reply, {
    generated_at: Date.now(),
    count: gaps.length,
    longest_gap_min: Math.round(gaps.reduce((m, g) => Math.max(m, g.durationMs), 0) / 60_000),
    gaps,
  }, 30);
});

// v0.7.5 — new analytics endpoints (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/self-consumption', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('selfConsumption', { days }), 60);
});

app.get('/api/thermal-events', async (req, reply) =>
  cached(req, reply, await analytics.report('thermalEvents'), 60),
);

app.get('/api/equipment-health', async (req, reply) =>
  cached(req, reply, await analytics.report('equipmentHealth'), 60),
);

app.get('/api/shade-report', async (req, reply) =>
  cached(req, reply, await analytics.report('shadeReport'), 60),
);

app.get('/api/soiling-decomposition', async (req, reply) =>
  cached(req, reply, await analytics.report('soilingDecomposition'), 60),
);

app.get('/api/string-mismatch', async (req, reply) =>
  cached(req, reply, await analytics.report('stringMismatch'), 60),
);

app.get('/api/ev-window-prediction', async (req, reply) =>
  cached(req, reply, await analytics.report('evWindowPrediction'), 60),
);

app.get('/api/charge-curve', async (req, reply) =>
  cached(req, reply, await analytics.report('chargeCurve'), 60),
);

app.get('/api/internal-resistance', async (req, reply) =>
  cached(req, reply, await analytics.report('internalResistance'), 60),
);

app.get<{ Querystring: { days?: string } }>('/api/forecast-skill', async (req, reply) => {
  const days = Math.max(1, Math.min(14, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('forecastSkill', { days }), 60);
});

app.get('/api/ambient-thermal-forecast', async (req, reply) =>
  cached(req, reply, await analytics.report('ambientThermal'), 60),
);

app.get('/api/confidence', async (req, reply) => {
  const [fc, deg, thermal, skill] = await Promise.all([
    analytics.report('forecast'),
    analytics.report('degradation'),
    analytics.report('ambientThermal'),
    analytics.report('forecastSkill'),
  ]);
  return cached(req, reply, computeConfidenceSnapshot(deg, fc, thermal, skill), 60);
});

app.get('/api/nws-alerts', async (req, reply) =>
  cached(req, reply, { alerts: await getActiveNwsAlerts() }, 60),
);

// v0.9.2 — weather ensemble (Open-Meteo + NWS NDFD when enabled). Returns
// the underlying forecast with per-hour ensembleSources + disagreement
// metadata so consumers can see WHY the bands are wider on hours with
// high inter-source disagreement.
// v0.13.3 — map weather hours to recorder GHI rows. Pure helper shared by the
// /api/weather/ensemble handler and the periodic persistence tick (below).
function weatherGhiRows(w: WeatherForecast): Array<{ epochMs: number; radiationWm2: number; cloudCoverPct: number }> {
  return w.hours.map((h) => ({
    epochMs: h.ts,
    radiationWm2: h.radiationWm2,
    cloudCoverPct: h.cloudCoverPct,
  }));
}

app.get('/api/weather/ensemble', async () => {
  const w = await getWeather((m) => app.log.info(m));
  if (!w) return { error: 'no weather available' };
  // v0.13.1 — persist the past+present hours' GHI + cloud cover to the
  // recorder so the irradiance series outlives the 2h in-memory weather
  // cache. With past_days=7 (weather.ts) one fetch backfills a full week,
  // which is what unblocks forecast-skill days 4-7 and feeds the soiling
  // estimator. Change-detected + idempotent, so calling this on every
  // (cached or fresh) fetch is cheap and never duplicates rows.
  if (recorder && w.hours.length > 0) {
    try {
      recorder.recordWeatherGhi(weatherGhiRows(w));
    } catch (e: any) {
      app.log.warn(`weather: GHI persistence failed (${e?.message ?? e}) — live forecast unaffected`);
    }
  }
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
 * the cloud-offline (online-on-LAN-but-cloud-says-offline) state the reboot was originally meant to address.
 * Every write is rate-limited + audit-logged.
 */
app.post<{ Params: { sn: string } }>('/api/device/refresh-cloud/:sn', { preHandler: requireWriteAuth }, async (req, reply) => {
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
 *  `x-write-debug-token` header. Audit-logged like any other write.
 *
 *  v0.9.62 hardening (defense-in-depth even though gated by env):
 *   - requireWriteAuth — must be HA-ingress / same-origin / token-bearing
 *   - per-SN cooldown (env SEND_CMD_COOLDOWN_MS, default 30s)
 *   - cmdSet allow-list — only known prefixes accepted
 *   - params depth + key-count + JSON-size caps
 */
const SEND_CMD_COOLDOWN_MS = Number(process.env.SEND_CMD_COOLDOWN_MS ?? 30_000);
const lastSendCommandAt = new Map<string, number>();
const ALLOWED_CMD_SETS = [
  'PD303_APP_SET',            // SHP2
  'WN511_PORTABLE_',          // DPU family (prefix)
  'WN511_BLE_FUNC_',          // DPU family (prefix)
];
function cmdSetAllowed(cmdSet: unknown): boolean {
  if (typeof cmdSet !== 'string' || cmdSet.length === 0) return false;
  return ALLOWED_CMD_SETS.some((p) =>
    p.endsWith('_') ? cmdSet.startsWith(p) : cmdSet === p,
  );
}
function paramsObjectOk(
  params: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (params == null) return { ok: true };
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, reason: 'params-must-be-object' };
  }
  // Depth + key-count walk (bounded so a hostile payload can't DOS the walker).
  let totalKeys = 0;
  function walk(node: unknown, depth: number): { ok: boolean; reason?: string } {
    if (depth > 5) return { ok: false, reason: 'params-too-deep (max depth 5)' };
    if (node == null || typeof node !== 'object') return { ok: true };
    if (Array.isArray(node)) {
      for (const item of node) {
        const r = walk(item, depth + 1);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    for (const k of Object.keys(node as Record<string, unknown>)) {
      totalKeys += 1;
      if (totalKeys > 100) return { ok: false, reason: 'params-too-many-keys (max 100)' };
      const r = walk((node as Record<string, unknown>)[k], depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  const walkRes = walk(params, 0);
  if (!walkRes.ok) return { ok: false, reason: walkRes.reason! };
  let serialized = '';
  try { serialized = JSON.stringify(params); } catch {
    return { ok: false, reason: 'params-not-serializable' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > 1024) {
    return { ok: false, reason: 'params-too-large (max 1KB serialized)' };
  }
  return { ok: true };
}

app.post<{ Body: { sn?: string; body?: Record<string, unknown> } }>(
  '/api/device/send-command',
  { preHandler: requireWriteAuth },
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
    // v0.9.62 — cmdSet allow-list. Reject anything that isn't a known
    // PD303 / WN511 prefix so a stolen token (or curious operator)
    // can't blast arbitrary cmdSets at the device. Log every rejection
    // to the audit trail so we can see attempted misuse.
    const cmdSet = body.body['cmdSet'] ?? body.body['cmdCode'];
    if (!cmdSetAllowed(cmdSet)) {
      appendWriteLog({
        ts: Date.now(),
        action: 'send-command',
        sn: body.sn,
        params: body.body,
        source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
        outcome: 'failure',
        code: 'cmdSet-not-allowlisted',
        message: `cmdSet=${String(cmdSet)} rejected by allow-list`,
      });
      reply.code(400);
      return {
        error: 'cmdSet-not-allowlisted',
        allowedPrefixes: ALLOWED_CMD_SETS,
        provided: cmdSet ?? null,
      };
    }
    // v0.9.62 — params shape guard (depth/keys/size).
    const paramsCheck = paramsObjectOk(body.body['params']);
    if (!paramsCheck.ok) {
      appendWriteLog({
        ts: Date.now(),
        action: 'send-command',
        sn: body.sn,
        params: body.body,
        source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
        outcome: 'failure',
        code: 'params-rejected',
        message: paramsCheck.reason,
      });
      reply.code(400);
      return { error: 'params-rejected', reason: paramsCheck.reason };
    }
    // v0.9.62 — per-SN cooldown (mirrors refreshShp2CloudPresence).
    const now = Date.now();
    const last = lastSendCommandAt.get(body.sn) ?? 0;
    if (now - last < SEND_CMD_COOLDOWN_MS) {
      const remainingMs = last + SEND_CMD_COOLDOWN_MS - now;
      reply.code(429);
      return {
        error: 'cooldown',
        remainingMs,
        message: `wait ${Math.ceil(remainingMs / 1000)}s before retrying`,
      };
    }
    lastSendCommandAt.set(body.sn, now);
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

/** Last N audit-log entries. Useful for the UI to show "last writes".
 *  v0.9.62 — gated by requireWriteAuth: the audit log can leak
 *  source-IPs, attempted command shapes, etc. — not catastrophic, but
 *  not appropriate for unauth LAN visitors either. */
app.get<{ Querystring: { limit?: string } }>(
  '/api/writes/log',
  { preHandler: requireWriteAuth },
  async (req) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50) || 50));
    return { entries: tailWriteLog(limit) };
  },
);

// v0.8.0 — sustainability, tariff, probabilistic forecasts, multi-day,
// dispatch planner, calendar, repair issues (all cached v0.9.14)
app.get<{ Querystring: { days?: string } }>('/api/carbon', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('carbon', { days }), 60);
});

app.get<{ Querystring: { days?: string } }>('/api/tariff', async (req, reply) => {
  const days = Math.max(1, Math.min(30, Number(req.query.days ?? 7) || 7));
  return cached(req, reply, await analytics.report('tariff', { days }), 60);
});

app.get('/api/forecast/probabilistic', async (req, reply) =>
  cached(req, reply, await analytics.report('probabilisticForecast'), 60),
);

app.get<{ Querystring: { days?: string } }>('/api/forecast/multi-day', async (req, reply) => {
  const days = Math.max(1, Math.min(7, Number(req.query.days ?? 3) || 3));
  return cached(req, reply, await analytics.report('multiDayForecast', { days }), 60);
});

app.get('/api/dispatch-plan', async (req, reply) => {
  const fc = await analytics.report('forecast');
  return cached(req, reply, computeDispatchPlan(store.get().devices, fc), 60);
});

app.get('/api/root-cause', async (req) => {
  const id = (req.query as any).alertId as string | undefined;
  if (!id) return { causes: [] };
  return { causes: rootCausesFor(id) };
});

app.get('/api/calendar.ics', async (req, reply) => {
  const [fc, ev] = await Promise.all([
    analytics.report('forecast'),
    analytics.report('evWindowPrediction'),
  ]);
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
  cached(req, reply, await analytics.report('bayesianSolar'), 60),
);

app.get('/api/pack-risk', async (req, reply) => {
  const [deg, therm, ir, cc] = await Promise.all([
    analytics.report('degradation'),
    analytics.report('thermalEvents'),
    analytics.report('internalResistance'),
    analytics.report('chargeCurve'),
  ]);
  return cached(req, reply, computePackRiskScores(store.get().devices, deg, therm, ir, cc), 60);
});

// v0.9.4 — trained ML risk scoring. Surfaces three side-by-side signals
// per pack: heuristic (v0.9.0), trained logistic regression, unsupervised
// novelty. Composite = mean of the three. modelVersion is honest about
// whether real labels exist (lr-labeled-v1) vs heuristic-distilled
// (lr-heuristic-baseline-v1). When real failures accumulate, drop a CSV
// into data/labels.csv and run `npm run train-pack-risk`.
app.get('/api/pack-risk/v2', async (req, reply) => {
  const [deg, therm, ir, cc] = await Promise.all([
    analytics.report('degradation'),
    analytics.report('thermalEvents'),
    analytics.report('internalResistance'),
    analytics.report('chargeCurve'),
  ]);
  const heur = computePackRiskScores(store.get().devices, deg, therm, ir, cc);
  return cached(req, reply, computePackRiskV2(store.get().devices, heur.packs, deg, therm, ir, cc), 60);
});

app.get('/api/repair-issues', async (req, reply) => {
  const [forecastSkill, degradation, soiling, equipmentHealth] = await Promise.all([
    analytics.report('forecastSkill'),
    analytics.report('degradation'),
    analytics.report('soilingDecomposition'),
    analytics.report('equipmentHealth'),
  ]);
  return cached(req, reply, computeRepairIssues({
    devices: store.get().devices,
    alerts: store.get().alerts ?? [],
    degradation,
    soiling,
    equipmentHealth,
    forecastSkill,
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
  const shp2 = findShp2(snap.devices);

  // v0.9.74 — only SHP2-bound DPUs count toward fleet totals. Spare cores
  // (here, the operator's Cores 4 + 5) inflate every "fleet PV / battery net /
  // total in / total out" reading because their energy can't actually
  // reach the home power bus. The previous code summed all 5 cores and
  // overstated the home's available capacity by ~40%.
  // v0.52.0 — the per-pack fleet flow loop is shared with mqttDiscovery's
  // buildState via aggregateFleetFlow (raw, un-rounded sums; rounded at emission).
  const { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad } = aggregateFleetFlow(snap.devices);

  // Cached projections (internally cached ~30min — cheap to call per-request).
  const [fc, deg, runway, rte, clipping, curtailment, selfCons, carbon, tariff] = await Promise.all([
    analytics.report('forecast'),
    analytics.report('degradation'),
    analytics.report('runway'),
    analytics.report('roundTripEfficiency'),
    analytics.report('clipping'),
    analytics.report('curtailment'),
    analytics.report('selfConsumption'),
    analytics.report('carbon'),
    analytics.report('tariff'),
  ]);
  const lifetime = recorder.getLifetimeTotals();
  const lifetimeKwh = makeLifetimeKwh(lifetime);
  // v0.8.0 additions — carbon + tariff fetched in the Promise.all above.

  // Soonest projected EOL = the pack with the fewest years left.
  const { projecting, soonest } = soonestProjecting((deg as import('./analytics.js').FleetDegradation).packs);
  type Pack = (typeof projecting)[number];
  const peerOutliers = projecting.filter((p) => p.peerOutlier);
  const eolLabel = (p: Pack | null) =>
    p == null
      ? null
      : p.coreNum != null
        ? `Core ${p.coreNum} · Pack ${p.packNum}`
        : `${p.device} · Pack ${p.packNum}`;

  // Alert counts split by source × severity.
  const alerts = snap.alerts ?? [];
  const cnt = makeAlertCounter(alerts);

  const payload = {
    generated_at: snap.generatedAt,

    // Power flow (watts, integers)
    fleet_pv_watts: Math.round(fleetPv),
    fleet_total_in_watts: Math.round(fleetIn),
    fleet_total_out_watts: Math.round(fleetOut),
    fleet_battery_net_watts: Math.round(fleetBatteryNet), // v0.10.4 per-pack; positive = discharging
    panel_load_watts: Math.round(panelLoad),
    ac_import_watts: Math.round(acIn),
    // v0.40.0 — resolve via the grid-presence resolver, not `acIn < 5` (DPU ac_in is ~0 on
    // a PV/battery-covered home → falsely pinned off-grid 24/7). Matches /api/snapshot's
    // off_grid (snapshotForClient) and the alarm engine's grid-presence view.
    off_grid: !liveGridBackstop(snap.devices).present,

    // Battery — SHP2 backup pool
    backup_pool_percent: shp2?.projection.backupBatPercent ?? null,
    backup_reserve_percent: shp2?.projection.backupReserveSoc ?? null,
    backup_full_capacity_kwh: kwh1(shp2?.projection.backupFullCapWh),
    backup_remaining_kwh: kwh1(shp2?.projection.backupRemainWh),
    // v0.15.12 — the SHP2 reports both timers regardless of flow direction;
    // publishing both showed "1.7 h to full" while the fleet was discharging.
    // Gate each on the (now correctly-signed) per-pack battery net: >+50 W =
    // discharging → charge timer inapplicable; <−50 W = charging → discharge
    // timer inapplicable; the ±50 W deadband publishes both (idle/ambiguous).
    backup_charge_minutes: fleetBatteryNet > 50 ? null : (shp2?.projection.backupChargeTimeMin ?? null),
    backup_discharge_minutes: fleetBatteryNet < -50 ? null : (shp2?.projection.backupDischargeTimeMin ?? null),

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

    // Runway — live off-grid projection (v0.5.0). v0.15.11 — null hours on a
    // net-charging horizon publish a sentinel (not bare null → HA 'unknown') so
    // a healthy ">24 h" reading is distinguishable from a real telemetry outage.
    runway_to_reserve_hours: runwayHoursForPublish(runway.hoursToReserve, runway.unavailable),
    runway_to_empty_hours: runwayHoursForPublish(runway.hoursToEmpty, runway.unavailable),
    // v0.59.0 — the runway / projected-low-SoC numbers assume the ISLANDED case (no
    // grid). True when the grid is actively carrying the load, so a 0% / low-hour
    // reading is informational, not an actionable depletion threat — let HA
    // automations gate `runway < threshold` rules on this. The numeric sensors stay
    // continuous (islanding can begin any second); this flag is the gate.
    runway_projection_islanded_only: liveGridBackstop(snap.devices).backstopping,
    // v0.69.0 — the same islanded-only caveat applies to projected_low_soc_percent
    // above: a 0% / low projection during a grid-tied cycle is informational, not an
    // imminent-depletion threat. Discoverable companion to the runway flag so an HA
    // automation gating on `projected_low_soc < N` can suppress grid-tied false alarms.
    projected_low_soc_islanded_only: liveGridBackstop(snap.devices).backstopping,
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

    // v0.9.77 — SoC-saturation curtailment. Distinct from inverter clipping:
    // here the panels could produce more but batteries are full and home
    // load is below PV. The MPPTs throttle to match (load + standby) and
    // the rest is rejected at the array. Surface state + Wh + cumulative.
    pv_curtailment_active: curtailment.active,
    pv_curtailment_surplus_watts: curtailment.currentSurplusW,
    pv_curtailment_kwh_today: curtailment.todayKwh,
    pv_curtailment_kwh_7d: curtailment.recent7dKwh,
    pv_curtailment_inactive_reason: curtailment.inactiveReason,
    // The configured charge ceiling (chgMaxSoc) — the SoC the pool fills
    // to before curtailment can begin. Storm Guard raises it to 100.
    pv_curtailment_charge_ceiling_pct: curtailment.current.chargeCeilingPct,

    // Self-consumption — 7-day rolling (v0.7.5)
    pv_kwh_7d: selfCons.pvKwh,
    load_kwh_7d: selfCons.loadKwh,
    battery_charge_kwh_7d: selfCons.batteryChargeKwh,
    battery_discharge_kwh_7d: selfCons.batteryDischargeKwh,
    grid_import_kwh_7d: selfCons.gridImportKwh,
    solar_fraction_of_load_percent: selfCons.solarFractionOfLoadPct,
    direct_use_ratio_percent: selfCons.directUseRatioPct,
    // v0.69.0 — home-core coverage for the self-consumption KPIs. reporting < connected
    // means a SHP2-wired home core's own PV/charge telemetry is missing from the 7-day
    // integral (cloud-offline / projection-less), so solar_fraction undercounts.
    self_consumption_home_dpus_connected: selfCons.homeDpusConnected,
    self_consumption_home_dpus_reporting: selfCons.homeDpusReporting,
    self_consumption_coverage_partial: selfCons.homeDpusCoveragePartial,

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
    // Cloud-wedge diagnostic: devices the EcoFlow cloud reports OFFLINE but that
    // are still reachable on the LAN (per the configured HA ping binary_sensors)
    // — i.e. a cloud-session/MQTT wedge, not a real outage. 0 when the feature is
    // unconfigured (every offline device classifies 'unknown', not 'cloud_wedge').
    ecoflow_cloud_wedge_count: countCloudWedges(devices),
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

app.post('/api/notify/test', { preHandler: requireWriteAuth }, async (_req, reply) => {
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
    const entry = {
      ts: Date.now(),
      alertId,
      category: liveAlert?.category ?? snap?.category,
      severity: liveAlert?.severity ?? snap?.severity,
      outcome: outcome as AlertOutcome,
      notes: notes && typeof notes === 'string' ? notes.slice(0, 500) : undefined,
      features: snap?.features,
      // v0.9.59 — also thread through the captured LR feature vector
      // (populated for pack-level alerts; null/undefined for system /
      // SHP2 / EVSE alerts where the pack-risk LR doesn't apply).
      lrFeatures: snap?.lrFeatures,
      alertFiredAt: snap?.ts,
      source: {
        ip: req.ip,
        ua: req.headers['user-agent']?.toString(),
      },
    };
    appendAlertOutcome(entry);
    // v0.9.27 — online LR weight update. Fires only when we have features
    // captured AND the outcome is labelable (not 'resolved'). The shadow
    // model file at /data/models/pack-risk-lr-v1-online.json accumulates
    // updates; the baseline file is never overwritten.
    let onlineLrResult: ReturnType<typeof updateFromOutcome> | null = null;
    try {
      onlineLrResult = updateFromOutcome(entry, (m) => app.log.info(m));
    } catch (e: any) {
      app.log.warn(`onlineLR: update failed: ${e?.message ?? e}`);
    }
    // Outcome captured — drop the feature snapshot to free memory.
    // (The persisted JSONL keeps it for any future bulk re-training.)
    dropSnapshot(alertId);
    return { ok: true, onlineLrUpdated: onlineLrResult?.updated ?? false };
  },
);

/* v0.9.27 — Model Health (track A completion). Aggregate report across
 *  all models. Used by the Science-station Model Health panel. */
app.get('/api/models/health', async (req, reply) =>
  cached(req, reply, computeModelHealth(), 60),
);

/* v0.9.27 — Physics: clear-sky PV theoretical maximum + realized score.
 *  Tells the operator how much of "physics says we should be making"
 *  we're actually producing — normalizes away time-of-day + season. */
app.get('/api/physics/pv-pmax', async (req, reply) => {
  const ts = Date.now();
  // Ambient defaults to Phoenix typical for season; could plug NWS here later.
  const ambient = 30;  // °C — placeholder; real call would use weather.ts
  const dpus = onlineDpus(store.get().devices);
  const realizedW = dpus.reduce((s, d) => s + ((d.projection as any).pvTotalWatts ?? 0), 0);
  const result = physicsPmax(ts, ambient, PHOENIX_SITE);
  return cached(req, reply, {
    ...result,
    realizedW,
    score: physicsScore(realizedW, result.pMaxW),
  }, 30);
});

/* v0.9.27 — Physics: per-pack LFP OCV analysis. Surfaces "physics SoC
 *  says X but BMS says Y" for each pack, flagging miscalibration. */
app.get('/api/physics/lfp-soc', async (req, reply) => {
  const dpus = onlineDpus(store.get().devices);
  const results: Array<{ device: string; packNum: number; analysis: ReturnType<typeof analyzePackLfp> }> = [];
  for (const d of dpus) {
    const p = d.projection as any;
    for (const pk of (p.packs ?? [])) {
      // We don't currently track per-pack "last non-resting" timestamp, so we
      // proxy via: if the current pack draw is low NOW, assume rested. This
      // is conservative — confidence stays low until we add proper tracking.
      const packCurrentA = pk.outputWatts != null && pk.totalVoltage != null && pk.totalVoltage > 0
        ? pk.outputWatts / pk.totalVoltage
        : null;
      const analysis = analyzePackLfp({
        packVoltageMv: pk.packVoltageMv ?? pk.adBatVoltageMv ?? null,
        reportedSoCPct: pk.soc ?? null,
        cellVoltagesMv: pk.cellVoltagesMv ?? [],
        packCurrentA,
        lastNonRestingAtMs: null, // not tracked yet — analysis will note this
      });
      results.push({ device: d.deviceName, packNum: pk.num, analysis });
    }
  }
  return cached(req, reply, { packs: results, generatedAt: Date.now() }, 30);
});

/* v0.9.27 — Hierarchical Bayesian fit on pack SoH. Returns per-pack
 *  posteriors (shrunken toward DPU + fleet means) and flags outliers. */
app.get('/api/models/hierarchical-pack-soh', async (req, reply) => {
  const dpus = onlineDpus(store.get().devices);
  const obs: HBPackObs[] = [];
  for (const d of dpus) {
    const p = d.projection as any;
    for (const pk of (p.packs ?? [])) {
      const sohValue = pk.actSoh ?? pk.soh;
      if (sohValue == null) continue;
      // Estimate per-observation σ from the cycle count. Newer packs (low
      // cycles) have noisier SoH estimates; older packs have settled.
      const sigma = Math.max(0.3, 3.0 - Math.min(2.5, (pk.cycles ?? 0) / 500));
      obs.push({
        packKey: `${d.sn}:${pk.num}`,
        dpuKey: d.sn,
        value: sohValue,
        obsSigma: sigma,
      });
    }
  }
  const fit = fitHierarchical(obs);
  const outliers = findOutliers(fit, 2.0);
  return cached(req, reply, {
    generatedAt: Date.now(),
    metric: 'pack_soh_pct',
    packs: fit.packs,
    dpuMeans: Object.fromEntries(fit.dpuMeans),
    fleetMean: fit.fleetMean,
    sigmaWithinDpu: fit.sigmaWithinDpu,
    sigmaWithinFleet: fit.sigmaWithinFleet,
    outlierPackKeys: outliers.map((o) => o.packKey),
  }, 300);
});

/* v0.9.27 — MPC dispatch recommendation. Recommend-only (doesn't
 *  apply any setpoints) but surfaces "if you set reserve to X at hour Y
 *  for the next 24h, here's the projected $ savings." */
app.get('/api/dispatch/recommend', async (req, reply) => {
  const shp2 = findShp2(store.get().devices);
  if (!shp2 || shp2.projection?.kind !== 'shp2') {
    reply.code(503);
    return { error: 'SHP2 not online' };
  }
  const sp: any = shp2.projection;
  // Pull current forecast + load history for the next 24 h.
  let fc: any = null;
  try { fc = await analytics.report('forecast'); } catch { /* */ }
  // v0.9.59 — feed the MPC the actual per-hour PV+load curve from the
  // day-ahead forecast instead of flat-filling with the 24 h mean. Without
  // the diurnal signal the planner can't distinguish midday charging from
  // evening discharge, so TOU arbitrage was impossible. Pull the P10
  // (pessimistic) PV band from the probabilistic forecast so the planner
  // can use a risk-averse PV envelope when sizing pre-peak imports.
  // Fall back to flat-fill only if no forecast hours are available.
  const recentLoadW = (sp.circuits ?? []).reduce(
    (s: number, c: any) => s + (c.watts ?? 0), 0,
  );
  const fallbackLoadKwh = recentLoadW / 1000;
  const fallbackPvKwh = (fc?.forecastPvWhNext24 ?? 0) / 24000;
  const fcHours: any[] = Array.isArray(fc?.hours) ? fc.hours : [];
  // Pull the probabilistic band so we have a real P10 PV envelope.
  let probHours: any[] = [];
  try {
    if (fc) {
      const prob = await analytics.report('probabilisticForecast');
      probHours = Array.isArray(prob?.hours) ? prob.hours : [];
    }
  } catch { /* probabilistic is optional — fall through */ }
  const pvP50: number[] = new Array(24).fill(fallbackPvKwh);
  const pvP10: number[] = new Array(24).fill(fallbackPvKwh * 0.6);
  const loadForecast: number[] = new Array(24).fill(fallbackLoadKwh);
  for (let i = 0; i < 24; i++) {
    const fh = fcHours[i];
    if (fh) {
      pvP50[i] = (fh.forecastPvW ?? 0) / 1000;
      loadForecast[i] = (fh.forecastLoadW ?? 0) / 1000;
    }
    const pb = probHours[i];
    if (pb) {
      pvP10[i] = (pb.p10W ?? pvP50[i] * 1000 * 0.7) / 1000;
    } else if (fh) {
      // No probabilistic band for this hour — synthesize a conservative
      // 70% P50 floor so the risk-averse branch still has something to bite.
      pvP10[i] = pvP50[i] * 0.7;
    }
  }
  // Tariff: the operator's APS plan is flat $0.17/kWh (no TOU). Default both peak
  // and off-peak to TARIFF_FLAT_CENTS_PER_KWH (17 ¢ default), but still
  // honor the legacy TARIFF_ON_PEAK_CENTS_PER_KWH / TARIFF_OFF_PEAK_CENTS_PER_KWH
  // overrides so a TOU-plan user can split them back out without code change.
  // Canonical tariff constants live in analytics.ts; v0.9.58 keeps them in
  // sync via the shared TARIFF_FLAT_CENTS_PER_KWH env var.
  const flatCents = Number(process.env.TARIFF_FLAT_CENTS_PER_KWH ?? 17);
  const onPeak = Number(process.env.TARIFF_ON_PEAK_CENTS_PER_KWH ?? flatCents);
  const offPeak = Number(process.env.TARIFF_OFF_PEAK_CENTS_PER_KWH ?? flatCents);
  const tariffByHour: number[] = Array.from({ length: 24 }, (_, h) =>
    h >= 15 && h < 20 ? onPeak : offPeak);
  // v0.15.2 — off-grid honesty fix. The hardcoded gridAvailable:true let the
  // optimizer "assume away" reserve dips via grid imports that physically don't
  // exist on this islanded site, producing dangerously optimistic plans. Default
  // false; a grid-tied user opts back in with GRID_AVAILABLE=true.
  const gridAvailable = process.env.GRID_AVAILABLE === 'true';
  // v0.15.2 — feed LIVE round-trip efficiency into the per-cycle cost: as the
  // pack ages and RTE drops, each round-trip wastes more real energy, so the DP
  // should increasingly prefer shedding/deferring over deep-cycling. Cost = base
  // wear + marginal energy loss valued at the flat tariff. Falls back to the
  // legacy 0.02 constant until RTE has enough coverage to report.
  let cyclingCostUsdPerKwh = 0.02;
  try {
    const rte: any = await analytics.report('roundTripEfficiency');
    const effFrac = rte?.efficiencyPct != null ? rte.efficiencyPct / 100 : null;
    if (effFrac != null && effFrac > 0 && effFrac <= 1) {
      const baseWear = Number(process.env.CYCLING_BASE_WEAR_USD_PER_KWH ?? 0.015);
      cyclingCostUsdPerKwh =
        Math.round((baseWear + (1 - effFrac) * (flatCents / 100)) * 10_000) / 10_000;
    }
  } catch { /* RTE is optional — keep the legacy default */ }
  const inputs: MpcInputs = {
    currentSocPct: sp.backupBatPercent ?? 50,
    reserveFloorPct: sp.backupReserveSoc ?? 20,
    capacityKwh: (sp.backupFullCapWh ?? 60_000) / 1000,
    pvForecastP50: pvP50,
    pvForecastP10: pvP10,
    loadForecast,
    tariffOnPeakCentsByHour: tariffByHour,
    gridAvailable,
    cyclingCostUsdPerKwh,
    reserveDipPenaltyUsdPerKwh: 1.0,
  };
  const result = recommendDispatch(inputs);
  return cached(req, reply, { inputs, ...result }, 300);
});

/* v0.9.27 — Forecast backtest. Replay the last 7 days of typical-day
 *  PV forecasting against recorder actuals; surface RMSE/MAE/bias/R². */
app.get('/api/backtest/forecast', async (req, reply) => {
  // v0.21.0 — score actuals over the SAME scope as the predictor: SHP2-connected
  // home DPUs only (the typical-PV curve is built from home DPUs — v0.9.76).
  // Summing actuals over spare bench cores too biased the reported R²/bias/MAE
  // on a fleet with spare panels.
  const connected = shp2ConnectedDpuSns(store.get().devices);
  const dpus = Object.values(store.get().devices)
    .filter((d) => d.projection?.kind === 'dpu' && isShp2Connected(d.sn, connected))
    .map((d) => d.sn);
  // Use the typical-PV (recent average) as the v1 forecaster.
  // Higher-fidelity backtests can swap in the Bayesian or full forecast.
  let typicalWhPerHour = 0;
  // v0.13.3 — P3-4: prefer the 24-slot diurnal curve over the flat
  // typicalPvWhPerDay/24 scalar. The flat predictor returns the same Wh at 2am
  // and noon, so it has ~no correlation with real diurnal PV (measured
  // r2≈-0.0006). v0.13.1 exposed typicalPvCurveWhPerHour on the forecast report
  // (night≈0, noon≈peak); pass it through so the backtest builds a diurnal
  // baseline via diurnalBaselinePredictor(curve)[hourOfDay] and scores a real R².
  // typicalWhPerHour stays as a back-comp fallback for builders without the curve.
  let typicalPvCurveWhPerHour: number[] | undefined;
  try {
    const fc: any = await analytics.report('forecast');
    typicalWhPerHour = (fc?.typicalPvWhPerDay ?? 0) / 24;
    typicalPvCurveWhPerHour = fc?.typicalPvCurveWhPerHour;
  } catch { /* */ }
  const score = await analytics.report('backtest', {
    dpuSns: dpus, hoursBack: 168, typicalWhPerHour, typicalPvCurveWhPerHour,
  });
  return cached(req, reply, { model: 'typical-day-baseline', ...score }, 600);
});

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

// v0.20.0 — serialize the snapshot frame once per emit and share it across all
// WS clients. The store hands the SAME `snap` reference to every listener within
// one synchronous emit, and `store.frameSeq` is bumped once per emit, so caching
// on frameSeq yields byte-identical frames per emit with one JSON.stringify
// instead of one-per-client. (store.get() === the emitted `snap`.)
let wsFrameSeq = -1;
let wsFrameStr = '';
function snapshotFrame(): string {
  if (store.frameSeq !== wsFrameSeq) {
    wsFrameStr = JSON.stringify({ type: 'snapshot', data: snapshotForClient() });
    wsFrameSeq = store.frameSeq;
  }
  return wsFrameStr;
}
app.get('/ws', {
  websocket: true,
  // v0.68.0 — reject cross-origin upgrades on the snapshot socket too, matching
  // the /console/ws policy and the CORS origin callback. Read-only telemetry,
  // but a cross-origin page shouldn't be able to stream the fleet snapshot.
  // Missing Origin (same-origin fetch / HA dashboards / curl) and LAN/same
  // origins still pass, so the React dashboard and Lovelace cards are unaffected.
  preValidation: (req, reply, done) => {
    const origin = req.headers.origin?.toString();
    if (origin && !isAllowedOrigin(origin, auth.sameOrigins)) {
      reply.code(403).send({ error: 'forbidden-origin' });
      return; // reply short-circuits the route → upgrade never happens
    }
    done();
  },
}, (socket) => {
  socket.send(snapshotFrame());
  const onChange = () => {
    if (socket.readyState === socket.OPEN) {
      socket.send(snapshotFrame());
    }
  };
  store.on('change', onChange);
  socket.on('close', () => store.off('change', onChange));
});

const stopPoll = startPollLoop(store, POLL_INTERVAL_MS, (m) => app.log.info(m));

// v0.13.3 — periodic GHI persistence. v0.13.1 only persisted the weather
// irradiance series from the /api/weather/ensemble HTTP handler, so GHI rows
// (which back forecast-skill days 4-7 and the soiling estimator) only landed
// when a dashboard was open. This tick calls getWeather() + recordWeatherGhi()
// on a ~45-min cadence so GHI persists reliably headless too. getWeather has a
// 2h in-memory cache, so most ticks are a cheap cache hit; recordWeatherGhi is
// change-detected + idempotent, so re-persisting the same rows never dupes.
const GHI_PERSIST_INTERVAL_MS = 45 * 60_000;
const ghiPersistTick = setInterval(() => {
  void (async () => {
    try {
      const w = await getWeather((m) => app.log.debug(m));
      if (recorder && w && w.hours.length > 0) {
        recorder.recordWeatherGhi(weatherGhiRows(w));
        app.log.debug(`weather: periodic GHI persistence (${w.hours.length} hours)`);
      }
    } catch (e: any) {
      app.log.debug(`weather: periodic GHI persistence skipped (${e?.message ?? e})`);
    }
  })();
}, GHI_PERSIST_INTERVAL_MS);
ghiPersistTick.unref();

// MQTT is best-effort; if it fails, REST polling still works.
// v0.10.4 — start with indefinite retry-with-backoff. A transient DNS
// brownout at boot (the 06-01 EAI_AGAIN event) previously left the add-on
// PERMANENTLY REST-only — this was a one-shot start with no retry, so a
// ~1-minute network blip downgraded telemetry resolution ~63% for days,
// undetected. Now a boot-time blip self-heals: keep retrying (10s → 30s →
// 60s → 120s → 5min cap) until MQTT connects. (mqtt.ts also retries the
// cert fetch, so this only fires on a longer outage.)
let stopMqtt: (() => void) | null = null;
const MQTT_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
// v0.75.0 — number of initial retry attempts during which a DNS/signature failure
// is a benign boot-window transient (logged at warn, not error). Covers the
// 10+30+60+120+300s backoff ≈ first ~9 min; a failure still recurring after that
// is genuinely persistent and escalates back to error so it stands out.
const MQTT_BOOT_GRACE_ATTEMPTS = Number(process.env.MQTT_BOOT_GRACE_ATTEMPTS ?? 5);
const startMqttWithRetry = async (attempt = 0): Promise<void> => {
  if (stopMqtt) return; // already connected (or a prior attempt won the race)
  try {
    const mqttHandle = await startMqtt(store, (m) => app.log.info(m));
    stopMqtt = mqttHandle.stop;
    if (attempt > 0) app.log.info(`mqtt: connected after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
  } catch (e: any) {
    const delay = MQTT_RETRY_MS[Math.min(attempt, MQTT_RETRY_MS.length - 1)];
    const msg = e?.message ?? String(e);
    // v0.75.0 — the first few boot-window failures are almost always a DNS race:
    // the Pi's resolver isn't up yet, so api-a.ecoflow.com fails to resolve
    // (EAI_AGAIN / ENOTFOUND) and the EcoFlow signature handshake then reports
    // 8521 "signature is wrong". These self-heal within ~10 min on the backoff and
    // REST polling (the alarm data path) never stops — so log them at WARN, not
    // ERROR, so a genuinely PERSISTENT auth/signature failure (still failing past
    // the boot window) stands out instead of being buried under benign boot
    // artifacts. After MQTT_BOOT_GRACE_ATTEMPTS the failure escalates back to error.
    // v0.76.0 — level selection extracted to the pure, tested classifyMqttStartFailure().
    const transientBoot = classifyMqttStartFailure(attempt, msg, MQTT_BOOT_GRACE_ATTEMPTS) === 'warn';
    const line = `mqtt: start failed (REST polling continues): ${msg} — retry in ${delay / 1000}s${transientBoot ? ' (boot-window transient)' : ''}`;
    if (transientBoot) app.log.warn(line);
    else app.log.error(line);
    setTimeout(() => { void startMqttWithRetry(attempt + 1); }, delay).unref();
  }
};
await startMqttWithRetry();

// Alert monitor: computes fleet alerts, attaches to the snapshot, pushes notifications.
const monitor = startAlertMonitor(store, recorder, (m) => app.log.info(m));
app.log.info(
  `notify: channel=${monitor.getConfig().channel} configured=${isConfigured(monitor.getConfig())}`,
);

// Control-room TUI — a menu-driven terminal view of the whole fleet, exposed
// two ways over ONE shared set of refresh timers:
//   • the raw telnet TCP server on :2323 (gated by TELNET_ENABLED); and
//   • a browser web terminal at /console on the web port :8787 (xterm.js over
//     a WebSocket), reachable on the LAN + pointable from a HA panel_iframe.
// v0.67.0 — the per-session render/input logic is transport-agnostic
// (TuiSession), reused by both. The web console is read-only, same LAN
// exposure as the already-unauthenticated telnet TUI.
let stopTelnet: (() => void) | null = null;
const stopTuiData = (() => {
  try {
    const tuiData = createTuiDataProvider({ store, recorder, log: (m) => app.log.info(m) });
    // Browser web terminal — always available on the web port (independent of
    // the telnet TCP toggle). Registered before app.listen().
    registerWsConsole({
      app,
      data: tuiData.provider,
      log: (m) => app.log.info(m),
      // Reject cross-origin ws upgrades using the SAME same-origin/LAN policy as
      // CORS (auth.ts isAllowedOrigin). Missing Origin (same-origin browser
      // fetch, HA panel_iframe, curl) is allowed by the caller in wsConsole.ts.
      isOriginAllowed: (origin) => (origin ? isAllowedOrigin(origin, auth.sameOrigins) : true),
    });
    app.log.info('console: web terminal available at /console');
    if (config.telnet.enabled) {
      stopTelnet = startTelnetServer({
        store,
        recorder,
        host: config.telnet.host,
        port: config.telnet.port,
        log: (m) => app.log.info(m),
        data: tuiData, // share the refresh timers
      }).stop;
      app.log.info(`telnet: control-room TUI on telnet://${config.telnet.host}:${config.telnet.port}`);
    }
    return tuiData.stop;
  } catch (e: any) {
    app.log.error(`console/telnet: failed to start: ${e?.message ?? e}`);
    return () => {};
  }
})();

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
// v0.10.0 — the analytics worker self-warms its report caches in a worker
// thread; the old main-thread cache-warmer (the dominant source of the
// multi-second event-loop blocks that tripped the Supervisor watchdog) is gone.

// v0.9.18 / v0.9.70 — Ship-wide audible broadcast. Listens for alert-
// condition transitions (green/yellow/red) and pushes a combined
// klaxon + TTS WAV (rendered on demand by audioRenderer.ts via
// Wyoming-direct to Piper) to every configured speaker through Music
// Assistant's play_announcement service.
// Off unless BROADCAST_ENABLED=true and at least one target is set.
const broadcast = startBroadcastMonitor(store, (m) => app.log.info(m), {
  klaxonDir: audioDir,
  cacheDir: audioRenderDir,
  cacheUrlPath: '/audio-render',
});

// v0.12.0 — backup-pool SoC audible alarm (40/30/20/15/10/8/4/2%, escalating priority).
const socAlarmEnabled = process.env.BATTERY_SOC_ALARM_ENABLED !== 'false';
// v0.23.0 — the grid-backstop snapshot for the CURRENT tick, recomputed once per
// store change (with a fresh HA cache when a grid entity is configured) and read
// by onCross — so the audible downgrade decision uses the same grid state as the
// on-screen alerts.ts path (no stale-cache divergence).
let socGridForTick = liveGridBackstop({});
// v0.23.0 — thresholds whose audible was grid-downgraded to a low advisory:
// pct → the TRUE (high/critical) priority. The SoC ladder is one-shot per
// downward crossing, so if the grid stops backstopping while the pool is still
// in a downgraded band, the dedicated audible would otherwise NEVER re-fire
// (fail-silent). We re-escalate it from the tick below.
const socDowngraded = new Map<number, AlarmPriority>();
const batterySocAlarm = createBatterySocAlarm({
  onCross: (t, isPrimary) => {
    // Grid-aware: when the grid is backstopping the home, a low pool is a
    // non-event (the SHP2 transfers to mains at the floor), so the emergency
    // tiers (high/critical — the ≤10% bands) collapse to a low advisory. Off-grid
    // (the safe default) keeps the original priority.
    // v0.76.0 — grid-aware downgrade decision extracted to the pure, tested
    // socGridCrossDecision() (was inline downgradePriorityForGrid + comparison).
    const { priority, onGrid } = socGridCrossDecision(t, socGridForTick.backstopping);
    // Record/clear the grid-downgrade re-escalation state for EVERY crossed band —
    // primary or not — so a later grid drop re-escalates every band the pool is
    // still in. v0.75.0 collapses only the ANNOUNCE (below), never this bookkeeping;
    // recording only the worst band would let a grid drop fail-silent on the higher
    // emergency bands after a partial recovery above the worst one.
    if (onGrid) socDowngraded.set(t.pct, t.priority);
    else socDowngraded.delete(t.pct);
    // v0.75.0 — only the most-severe band of a same-tick multi-band crossing
    // announces, so a reconnect-at-low-SoC (or fast discharge) produces ONE audible
    // alarm rather than laddering 50/40/30/20. The on-screen alert (activeSocBand)
    // shows the current band independently, and the per-band socDowngraded record
    // above is unaffected, so nothing is suppressed — only the audio is de-duped.
    if (!isPrimary) return;
    if (!isPriorityEnabled(priority)) return;          // honour the Alert Settings annunciation toggles
    const message = onGrid
      ? `Advisory. Backup pool at ${t.pct} percent — drawing from grid power, no action needed.`
      : socAlarmMessage(t);
    const messageEs = onGrid ? socAlarmAdvisoryEs(t.pct) : socAlarmMessageEs(t); // v0.62.0 — Spanish second pass
    void broadcast.announce(priority, message, messageEs);
  },
  log: (m) => app.log.info(m),
});
store.on('change', (snap: FleetSnapshot) => {
  if (!socAlarmEnabled) return;
  const shp2 = findShp2(snap.devices);
  const soc = shp2 && shp2.projection?.kind === 'shp2' ? shp2.projection.backupBatPercent : null;
  void (async () => {
    // Keep the grid-presence entity fresh (TTL-gated) so onCross + the
    // re-escalation below see live grid state. Assign + update run synchronously
    // after the await, so onCross reads exactly the grid computed for this tick.
    if (gridPresenceEntityId()) {
      try {
        await haStateCache.refreshIfStale();
      } catch {
        /* cold/stale cache ⇒ resolves to off-grid (safe) */
      }
    }
    socGridForTick = liveGridBackstop(snap.devices);
    batterySocAlarm.update(soc); // fires onCross synchronously, reading socGridForTick
    // Re-escalate a previously grid-downgraded crossing if the grid is no longer
    // backstopping while the pool is still at/below that threshold — closes the
    // one-shot fail-silent window on a grid drop.
    //
    // NOTE (do not "fix" as fail-silent): this store 'change' handler is NOT
    // driven only by SHP2 MQTT telemetry. SnapshotStore.setDeviceList() emits
    // 'change' UNCONDITIONALLY on every REST poll tick (snapshot.ts:174, via
    // refreshAll → setDeviceList, driven by startPollLoop every POLL_INTERVAL_MS,
    // default 60s — index.ts:98/1588), and that same poll refreshes acInWatts /
    // backupBatPercent / chargeWattPower via getQuotaAll; the grid-presence HA
    // entity is refreshed independently just above (haStateCache.refreshIfStale).
    // So this re-escalation self-heals on the ~60s REST cadence even under a
    // TOTAL MQTT stall — the poll loop is the de facto timer that closes the
    // grid-drop window; it does not depend on fresh SHP2 MQTT telemetry.
    // v0.76.0 — the grid-drop re-escalation pass is now the pure, tested
    // reEscalateGridDrop() (mutates socDowngraded + returns the bands to announce),
    // so the exact v0.75.0-regressed path is exercised by a test driving the REAL
    // function instead of a hand-copied mirror.
    for (const { pct, priority } of reEscalateGridDrop(socDowngraded, soc, socGridForTick.backstopping, isPriorityEnabled)) {
      void broadcast.announce(priority, socAlarmMessage({ pct, priority }), socAlarmMessageEs({ pct, priority }));
    }
  })();
});

// v0.14.0 — projection-depletion audible alarm. Rides the off-grid runway
// projection (forecast PV − forecast load over 24h): announces, with escalating
// priority, when the pool is projected to reach its reserve floor (or empty)
// before solar recovers — so load can be shed while the pool is still healthy,
// rather than only once the SoC ladder has already fallen to 50/40/30%. Polled
// (not store-driven) because the runway is an analytics-worker report; a 2-min
// cadence is far finer than the hourly re-announce throttle and the report is
// cached. Honours the same per-priority Alert-Settings toggles as the SoC alarm.
const runwayAlarmEnabled = process.env.BATTERY_RUNWAY_ALARM_ENABLED !== 'false';
const runwayAlarm = createRunwayAlarm({
  onTrigger: (priority, message, messageEs) => {
    if (!isPriorityEnabled(priority)) return;
    void broadcast.announce(priority, message, messageEs); // v0.62.0 — Spanish second pass
  },
  log: (m) => app.log.info(m),
});
if (runwayAlarmEnabled) {
  const runwayAlarmTick = setInterval(() => {
    void (async () => {
      try {
        // v0.23.0 — keep the grid-presence entity fresh (TTL-gated + coalesced)
        // so the floor classifier sees live grid state, then resolve the
        // backstop from the current snapshot and pass it into the alarm.
        if (gridPresenceEntityId()) {
          try {
            await haStateCache.refreshIfStale();
          } catch {
            /* best effort — a cold/stale cache resolves to NOT present (safe) */
          }
        }
        const r = await analytics.report('runway');
        runwayAlarm.update(r, liveGridBackstop(store.get().devices));
      } catch (e: any) {
        app.log.debug(`runway-alarm: poll skipped (${e?.message ?? e})`);
      }
    })();
  }, 2 * 60 * 1000);
  runwayAlarmTick.unref();
}

// Cloud-wedge vs real-outage reachability poll. EcoFlow's cloud gives NO device
// IP, so LAN reachability is read from operator-configured HA ping binary_sensors
// (ECOFLOW_DEVICE_REACHABILITY: SN → entity_id). Each tick we read those entity
// states into the deviceLink cache, which the alarm engine then consults to
// classify an offline device as a cloud-session wedge (reachable on the LAN) vs a
// real power/network outage (unreachable). Mirrors the grid-presence fetch: same
// async, non-blocking pattern, each HA read failure tolerated → 'unknown'. Fully
// dormant when ECOFLOW_DEVICE_REACHABILITY is unset/empty (the interval still
// runs but does nothing). Reads are independent of the SHP2 telemetry cadence so
// the classification stays fresh even under a total MQTT stall.
// v0.73.0 (finding #4) — in-flight guard so overlapping 30 s ticks coalesce. If a
// Supervisor read hangs (the 5 s/10 s caps below bound a single read, but a whole
// fan-out can still straddle a tick boundary), the next tick reuses the in-flight
// promise rather than launching a second concurrent fan-out. Mirrors haStateCache's
// `if (inflight) return inflight`.
let reachabilityInflight: Promise<void> | null = null;
async function refreshDeviceReachability(): Promise<void> {
  if (reachabilityInflight) return reachabilityInflight;
  reachabilityInflight = (async () => {
    const entities = deviceReachabilityEntities();
    await Promise.all(
      Object.entries(entities).map(async ([sn, entityId]) => {
        try {
          // v0.73.0 (finding #4) — explicit short caps so a hung Supervisor read
          // can't pile up across the 30 s poll. undici's default is ~5 min.
          const e = await getEntityState(entityId, { headersTimeoutMs: 4000, bodyTimeoutMs: 8000 });
          // A null read (HA unreachable / unknown entity) maps to 'unknown' — the
          // safe default that yields no enrichment rather than a fabricated up/down.
          setDeviceReachability(sn, interpretReachabilityState(e?.state ?? null));
        } catch {
          setDeviceReachability(sn, 'unknown');
        }
      }),
    );
  })().finally(() => { reachabilityInflight = null; });
  return reachabilityInflight;
}
{
  // Prime once at boot so the first offline alert can classify, then refresh on a
  // cadence finer than the alert-eval loop. unref() so it never holds the process.
  // v0.73.0 (finding #8) — match the interval tick's .catch so a boot-prime rejection
  // can't surface as an unhandled rejection.
  if (hasReachabilityConfig()) {
    void refreshDeviceReachability().catch((e: any) =>
      app.log.debug(`device-reachability: boot prime skipped (${e?.message ?? e})`),
    );
  }
  const reachabilityTick = setInterval(() => {
    if (!hasReachabilityConfig()) return; // dormant — no HA reads when unconfigured
    void refreshDeviceReachability().catch((e: any) =>
      app.log.debug(`device-reachability: refresh skipped (${e?.message ?? e})`),
    );
  }, 30 * 1000);
  reachabilityTick.unref();
}

// v0.23.0 — one-time boot advisory: an ISLANDED site (no grid backstop) with
// quiet hours configured and CRITICAL_BREAKS_QUIET_HOURS off means a genuine
// overnight off-grid emergency (backup floor, projected-empty) will NOT chime or
// push until the morning digest. The default is deliberately quiet, but make the
// trade-off explicit so an off-grid operator can opt back in if they want it.
{
  const offGrid = process.env.GRID_AVAILABLE !== 'true' && gridPresenceEntityId() === '';
  const critBreaks =
    process.env.CRITICAL_BREAKS_QUIET_HOURS === 'true' || process.env.CRITICAL_BREAKS_QUIET_HOURS === '1';
  const quietConfigured =
    (process.env.NOTIFY_QUIET_HOURS ?? '').trim() !== '' || (process.env.BROADCAST_QUIET_HOURS ?? '').trim() !== '';
  if (offGrid && quietConfigured && !critBreaks) {
    app.log.warn(
      'config: off-grid site + quiet hours + CRITICAL_BREAKS_QUIET_HOURS=false — genuine overnight ' +
        'battery/floor emergencies will be HELD until the morning digest (no chime/push). ' +
        'Set CRITICAL_BREAKS_QUIET_HOURS=true to be woken for critical alerts.',
    );
  }
}

// v0.15.2 — Intelligent load-shedding ADVISOR (Phase 1: read + advise, NO
// actuation). Reads the runway projection + live HA device state (haStateCache)
// + SHP2 circuit watts, decomposes the load, and recommends which loads to shed
// to extend runway (with an upper-bound counterfactual). The recommendation is
// surfaced at GET /api/load-shedding/status and as MQTT entities, so the
// operator's own HA automations can act on it. The add-on never toggles a load.
const loadShedAdvisoryEnabled = process.env.LOAD_SHEDDING_ADVISORY_ENABLED !== 'false';
initShedRegistry((m) => app.log.info(m));
const loadShedAdvisor = createLoadShedAdvisor({
  getCandidates: getShedCandidates,
  haEntity: (id) => haStateCache.getCachedEntity(id),
  shp2CircuitWatts: (ch) => {
    const shp2 = findShp2(store.get().devices);
    const circuits: any[] =
      shp2 && shp2.projection?.kind === 'shp2' ? ((shp2.projection as any).circuits ?? []) : [];
    const c = circuits.find((x) => x?.ch === ch);
    return c && typeof c.watts === 'number' ? c.watts : null;
  },
  thresholdHours: () => Number(process.env.LOAD_SHEDDING_RUNWAY_THRESHOLD_H ?? 4.0),
  restoreMarginHours: () => Number(process.env.LOAD_SHEDDING_RESTORE_MARGIN_H ?? 2.0),
});
if (loadShedAdvisoryEnabled) {
  const loadShedTick = setInterval(() => {
    void (async () => {
      try {
        // No allowlisted loads (the default) → nothing to advise on; skip the
        // HA state poll entirely so opted-out installs pay zero overhead.
        if (getShedCandidates().length === 0) return;
        await haStateCache.refreshIfStale();
        const r = await analytics.report('runway');
        loadShedAdvisor.update(r);
      } catch (e: any) {
        app.log.debug(`load-shed: advisory tick skipped (${e?.message ?? e})`);
      }
    })();
  }, 2 * 60 * 1000);
  loadShedTick.unref();
}

// Read-only advisory status. No auth: it exposes no secrets and actuates nothing.
app.get('/api/load-shedding/status', async () => ({
  enabled: loadShedAdvisoryEnabled,
  mode: 'advisory',
  candidatesConfigured: getShedCandidates().length,
  haStateCacheAgeMs: haStateCache.getCacheAgeMs(),
  advisory: loadShedAdvisor.getStatus(),
}));

// Diagnostics: the analytics worker is the cache warmer now (self-warming
// inside a worker thread). Endpoint kept for backward-compat.
app.get('/api/cache-warmer/status', async () => ({
  mode: 'worker-self-warm',
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
    // v0.23.0 — live grid-backstop state, so the operator can see whether the
    // floor alarms are currently in their downgraded (grid present) posture.
    grid: liveGridBackstop(store.get().devices),
    config: {
      enabled: cfg.enabled,
      targets: cfg.targets,
      audioBase: cfg.audioBase,
      volume: cfg.volume,
      // v0.15.8 — surface the RESOLVED announcement knobs so the operator can
      // verify what actually takes effect (e.g. that announceVolume resolved to
      // 100 with BROADCAST_VOLUME:1 + a blank BROADCAST_ANNOUNCE_VOLUME). null
      // announceVolume = "off"/standing (announce_volume omitted from the call).
      announceVolume: cfg.announceVolume,
      repeat: cfg.repeat,
      repeatGapMs: cfg.repeatGapMs,
      chimeGapMs: cfg.chimeGapMs,
      leadSilenceMs: cfg.leadSilenceMs,
      usePreAnnounce: cfg.usePreAnnounce,
      announceRetries: cfg.announceRetries,
      // v0.61.0 — "End of message" terminator on the final play (resolved state).
      endOfMessage: cfg.endOfMessage,
      endOfMessagePhrase: cfg.endOfMessagePhrase,
      endOfMessageGapMs: cfg.endOfMessageGapMs,
      // v0.62.0 — bilingual second pass (English + Spanish). `bilingualActive` is
      // the EFFECTIVE state: on only when a Spanish voice is also configured.
      bilingual: cfg.bilingual,
      bilingualActive: cfg.bilingual && cfg.secondLangVoice.length > 0,
      secondLangVoice: cfg.secondLangVoice,
      endOfMessagePhraseEs: cfg.endOfMessagePhraseEs,
      minSeverity: cfg.minSeverity,
      quietHours: cfg.quietHours,
      // v0.23.0 — whether critical alerts break through quiet hours (opt-in).
      criticalBreakThrough: cfg.criticalBreakThrough,
      // v0.9.70 — Wyoming is the canonical TTS path now. No engine
      // selector / fallback chain / language toggle / Sonos restore —
      // all that lived in v0.9.18-v0.9.69's broadcast complexity that
      // got removed when MA + Wyoming-direct replaced the tts_get_url
      // + media_player + per-protocol stagger machinery.
      wyomingHost: cfg.wyomingHost,
      wyomingPort: cfg.wyomingPort,
      wyomingVoice: cfg.wyomingVoice,
    },
  };
});

// v0.18.0 — live broadcast enable + volume, mutable from the UI without a
// restart. The env (BROADCAST_ENABLED / BROADCAST_VOLUME) is the boot baseline;
// a /data override (set here) wins at runtime and persists. The response
// surfaces effective / override / envBaseline so the UI can show default-vs-
// overridden and disclose when an env-pinned BROADCAST_ANNOUNCE_VOLUME makes the
// volume slider audibly inert.
const broadcastConfigRateLimit = makeRateLimiter(30, 60_000);
function broadcastConfigResponse() {
  const cfg = broadcast.config();              // effective (override already merged in loadBroadcastConfig)
  const ov = getBroadcastRuntimeConfig();      // the /data override (null fields = deferring to env)
  const envEnabled = process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1';
  const envVolRaw = Number(process.env.BROADCAST_VOLUME ?? 0.5);
  const envVolume = Number.isFinite(envVolRaw) ? Math.max(0, Math.min(1, envVolRaw)) : 0.5;
  const announceVolumePinned = (process.env.BROADCAST_ANNOUNCE_VOLUME ?? '').trim().length > 0;
  return {
    enabled: cfg.enabled,
    volume: cfg.volume,
    announceVolume: cfg.announceVolume,
    // When true, BROADCAST_ANNOUNCE_VOLUME pins the announce volume and the
    // master slider is informational only (no audible effect).
    announceVolumePinned,
    source: ov.source,
    updatedAt: ov.updatedAt,
    override: { enabled: ov.enabled, volume: ov.volume }, // null = deferring to env
    envBaseline: { enabled: envEnabled, volume: envVolume },
  };
}

// GET — current effective broadcast enable/volume + override + env baseline. NO
// auth: read-only and non-sensitive (matches /api/broadcast/status).
app.get('/api/broadcast/config', async () => broadcastConfigResponse());

// PUT — set or clear the runtime enable/volume override. Write-gated + rate
// limited (touches /data). A field present sets it (boolean/number overrides
// env; explicit null clears back to the env baseline); an absent field is
// unchanged.
app.put<{ Body: { enabled?: boolean | null; volume?: number | null } }>(
  '/api/broadcast/config',
  { preHandler: [requireWriteAuth, broadcastConfigRateLimit] },
  async (req) => {
    // Guard the body SHAPE before the `in` operator — the raw JSON parser passes
    // primitives through, and `'enabled' in 42` throws. A non-object body is a
    // no-op patch (the response still echoes the current effective config).
    const body: { enabled?: boolean | null; volume?: number | null } =
      req.body && typeof req.body === 'object' ? req.body : {};
    const patch: { enabled?: boolean | null; volume?: number | null } = {};
    if ('enabled' in body) patch.enabled = body.enabled;
    if ('volume' in body) patch.volume = body.volume;
    const next = updateBroadcastRuntimeConfig(patch, 'web');
    appendWriteLog({
      ts: Date.now(),
      action: 'broadcast-config',
      sn: '', // global, not device-specific
      params: { enabled: next.enabled, volume: next.volume },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return broadcastConfigResponse();
  },
);

app.post<{ Body: { level?: 'red' | 'yellow' | 'green' } }>(
  '/api/broadcast/test',
  { preHandler: requireWriteAuth },
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

/* ──────────────────────────────────────────────────────────────────────
 * v0.11.0 — Alert Settings (ISA-18.2 / IEC 62682 alarm-priority annunciation
 * toggles + chime repeat) and per-priority announcement preview.
 *
 * The internal Alert.severity union is unchanged; priority is DERIVED. These
 * routes expose the user-mutable annunciation layer (alertSettings.ts) and a
 * preview that renders/plays exactly what each priority sounds like.
 * ────────────────────────────────────────────────────────────────────── */

/** Serialize the current settings into the cross-group contract shape. */
function alertSettingsResponse() {
  const settings = getAlertSettings();
  return {
    priorities: ALARM_PRIORITY_ORDER.map((id) => {
      const m = ALARM_PRIORITY_META[id];
      return {
        id: m.id,
        label: m.label,
        isa: m.isa,
        rank: m.rank,
        tag: m.tag,
        colorToken: m.colorToken,
        description: m.description,
        response: m.response,
        enabled: settings.priorityEnabled[id] !== false,
      };
    }),
    chimeRepeat: settings.chimeRepeat,
    // The add-on baseline, surfaced so the UI can show the real default instead
    // of a hardcoded literal (mirrors the broadcast card's envBaseline).
    chimeRepeatDefault: DEFAULT_CHIME_REPEAT,
    updatedAt: settings.updatedAt,
  };
}

// GET — current annunciation settings. NO auth: read-only and non-sensitive
// (matches /api/broadcast/status, which is also unauthenticated).
app.get('/api/alert-settings', async () => alertSettingsResponse());

// PUT — update per-priority enable flags and/or chime repeat. Write-gated.
app.put<{ Body: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>>; chimeRepeat?: number } }>(
  '/api/alert-settings',
  { preHandler: requireWriteAuth },
  async (req) => {
    const body = req.body ?? {};
    const next = updateAlertSettings(
      { priorityEnabled: body.priorityEnabled, chimeRepeat: body.chimeRepeat },
      'web',
    );
    appendWriteLog({
      ts: Date.now(),
      action: 'alert-settings',
      sn: '', // not device-specific — settings are global annunciation toggles
      params: { priorityEnabled: next.priorityEnabled, chimeRepeat: next.chimeRepeat },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return alertSettingsResponse();
  },
);

// POST — preview a priority's announcement in the browser or on the speakers.
const PREVIEW_PRIORITIES: AlarmPriority[] = ['critical', 'high', 'medium', 'low'];
app.post<{ Body: { priority?: AlarmPriority; target?: 'browser' | 'speakers' } }>(
  '/api/alert-preview',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const priority = req.body?.priority;
    const target = req.body?.target;
    if (!priority || !PREVIEW_PRIORITIES.includes(priority)) {
      reply.code(400);
      return { ok: false, error: 'priority must be one of critical, high, medium, low' };
    }
    if (target !== 'browser' && target !== 'speakers') {
      reply.code(400);
      return { ok: false, error: "target must be 'browser' or 'speakers'" };
    }
    const r = await broadcast.preview(priority, target);
    // Mirror /api/broadcast/test: 429 on cooldown, 502 on real failure, 200 ok.
    if (!r.ok) {
      const isCooldown = r.cooldownRemainingMs != null && r.cooldownRemainingMs > 0;
      reply.code(isCooldown ? 429 : 502);
    }
    return r;
  },
);

/* ─── v0.15.23 Alert Console — chime tone library + per-level assignment ───
 * Upload your own alarm tones (POST /api/chimes, raw WAV body) and assign one
 * per level (PUT /api/chime-config). The tone PREPENDS the spoken message in
 * place of the synthesized klaxon. All gated by requireWriteAuth (ingress /
 * same-origin), audit-logged, and normalized + validated by chimeStore. A bad
 * or deleted tone degrades to the built-in klaxon (chimeConfig.resolveChime),
 * never a silent alarm. Browser preview plays /chimes/<id>.wav directly. */
function chimeConsoleResponse() {
  const cfg = getChimeConfig();
  return {
    levels: CHIME_LEVELS,
    // UI labels for the 3 audio levels (the 4 ISA priorities collapse to these).
    levelLabels: { red: 'Critical', yellow: 'Caution', green: 'All-clear / Recovery' } as Record<AnnouncementLevel, string>,
    assignments: cfg.assignments,
    chimes: listChimes(),
    // v0.17.0 — the named built-in tone library, selectable per level alongside
    // the level default and uploads. Preview each at /audio/<id>.wav.
    builtinTones: BUILTIN_TONES,
    updatedAt: cfg.updatedAt,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

// List uploaded tones + current per-level assignments (read-only).
app.get('/api/chimes', async () => ({ ok: true, ...chimeConsoleResponse() }));
app.get('/api/chime-config', async () => ({ ok: true, ...chimeConsoleResponse() }));

// Upload a tone — raw WAV bytes in the body, display name in ?name=. chimeStore
// validates the RIFF/WAVE header, normalizes to 22050/16/mono, and stores it
// under a content-addressed id (no client filename ever touches a path).
app.post<{ Querystring: { name?: string } }>(
  '/api/chimes',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      reply.code(400);
      return { ok: false, error: 'expected a WAV file body (set Content-Type: audio/wav)' };
    }
    const name = typeof req.query.name === 'string' ? req.query.name : 'tone.wav';
    const res = saveChime(buf, name);
    if (!res.ok) {
      reply.code(400);
      return { ok: false, error: res.error };
    }
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-upload',
      sn: '',
      params: { id: res.meta!.id, name: res.meta!.originalName, bytes: res.meta!.sizeBytes, durationMs: res.meta!.durationMs },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return { ok: true, chime: res.meta, ...chimeConsoleResponse() };
  },
);

// Delete a tone — reverts any level currently assigned to it back to built-in
// (an assignment can never dangle at a missing file).
app.delete<{ Params: { id: string } }>(
  '/api/chimes/:id',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const id = req.params.id;
    const revertedAssignments = revertAssignmentsFor(id);
    const removed = deleteChime(id);
    if (!removed) {
      reply.code(404);
      return { ok: false, error: 'tone not found' };
    }
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-delete',
      sn: '',
      params: { id, revertedAssignments },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: 'success',
    });
    return { ok: true, ...chimeConsoleResponse() };
  },
);

// Assign tones per level. Rejects ids that don't exist (keeps prior value).
app.put<{ Body: { assignments?: Partial<Record<AnnouncementLevel, ChimeAssignment>> } }>(
  '/api/chime-config',
  { preHandler: [requireWriteAuth, chimeWriteRateLimit] },
  async (req, reply) => {
    const patch = req.body?.assignments ?? {};
    const { rejected } = updateChimeConfig(patch, 'web');
    appendWriteLog({
      ts: Date.now(),
      action: 'chime-config',
      sn: '',
      params: { assignments: getChimeConfig().assignments, rejected },
      source: { ip: req.ip, ua: req.headers['user-agent']?.toString() },
      outcome: rejected.length ? 'failure' : 'success',
      message: rejected.length ? rejected.join('; ') : undefined,
    });
    if (rejected.length) reply.code(422);
    return { ok: rejected.length === 0, rejected, ...chimeConsoleResponse() };
  },
);

// v0.9.70 — removed endpoints that pre-dated the Wyoming-direct rewrite:
//   - /api/broadcast/tts-services (engine picker + sample messages)
//     was the v0.9.29 multi-engine picker UI. v0.9.70 only uses Wyoming.
//   - /api/broadcast/tts-debug (raw service catalog dump) was the
//     v0.9.32 "why doesn't Piper appear" diagnostic. Wyoming-direct
//     bypasses HA's TTS service catalog entirely.
//   - /api/broadcast/test-tts (engine + target isolation) was the
//     v0.9.35 surgical test for which engine 500s. The full-pipeline
//     /api/broadcast/test covers this now since there's only one path.
// The /api/broadcast/setup-piper + /api/broadcast/reset-piper endpoints
// stay — they're still useful for first-time Wyoming integration setup
// even though the broadcast path no longer routes through HA's TTS layer.

/**
 * v0.9.33 — List installed Supervisor add-ons. Requires `hassio_api: true`
 * + role `manager` (added in v0.9.33). Used to verify the Piper add-on
 * is actually running before we attempt to bridge it via Wyoming Protocol.
 */
app.get('/api/admin/addons', { preHandler: requireWriteAuth }, async (_req, reply) => {
  const addons = await listAddons();
  if (!addons) {
    reply.code(503);
    return {
      ok: false,
      error: 'Supervisor add-on API unavailable. Add-on may lack hassio_api permission (was added in v0.9.33). After updating, the user must reapprove the add-on permissions in Home Assistant → Settings → Add-ons → Power.',
    };
  }
  return { ok: true, count: addons.length, addons };
});

/**
 * v0.9.33 — Auto-setup the Wyoming Protocol integration for Piper.
 *
 * v0.9.31-32 testing established that installing the Piper add-on isn't
 * enough — HA also needs the Wyoming Protocol integration to bridge to
 * it, which exposes the `tts.piper` entity. Without this, the panel sees
 * only `tts.cloud_say` and the spoken alert depends entirely on Nabu
 * Casa uptime (which 500'd twice during testing).
 *
 * This endpoint:
 *   1. Checks if a Wyoming config-entry already exists for this host+port.
 *   2. If yes → returns "already configured".
 *   3. If no → kicks off the Core config flow, submits host+port form data,
 *      and reports the result.
 *
 * Defaults to host=`core-piper`, port=10200 — the add-on's standard
 * Wyoming exposure. Override via query params for non-standard setups.
 */
/**
 * v0.9.43 — Wipe + re-add the Wyoming Protocol integration.
 *
 * v0.9.41 diagnosed the operator's tts.piper entity as empty (no voice metadata
 * pulled from Piper) — the Wyoming integration was likely added BEFORE
 * he configured a voice in the Piper add-on, and it cached the empty
 * state. tts.speak then 500s because HA has no voice to render with.
 *
 * This endpoint:
 *   1. Lists all wyoming config-entries
 *   2. Deletes any whose data.host matches the Piper add-on hostname
 *   3. Re-runs the v0.9.33 setup-piper flow to re-add cleanly
 *
 * After this, the Wyoming integration will re-pull Piper's voice list
 * on connect — assuming the operator has saved a voice in Piper add-on config.
 */
app.post<{ Querystring: { host?: string; port?: string } }>(
  '/api/broadcast/reset-piper',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const host = req.query.host ?? 'core-piper';
    const port = Number(req.query.port ?? 10200);
    const existing = await listConfigEntries('wyoming');
    if (!existing) {
      reply.code(503);
      return { ok: false, error: 'Could not list Wyoming config entries (hassio_api access?)' };
    }
    const matching = existing.filter((e) => {
      const data = e.data as Record<string, unknown> | undefined;
      return data && data.host === host && (port === 0 || Number(data.port) === port);
    });
    const deleted: Array<{ entry_id: string; ok: boolean; error?: string }> = [];
    for (const entry of matching) {
      const entryId = String((entry as Record<string, unknown>).entry_id ?? '');
      if (!entryId) continue;
      const d = await deleteConfigEntry(entryId);
      deleted.push({ entry_id: entryId, ok: d.ok, error: d.error });
    }
    // Now re-add via the v0.9.33 setup flow.
    const startRes = await startConfigFlow('wyoming');
    if (!startRes.ok) {
      reply.code(502);
      return { ok: false, deleted, error: `re-add flow failed: ${startRes.error ?? startRes.status}`, body: startRes.body };
    }
    const flow = startRes.body as { flow_id?: string; type?: string };
    if (!flow.flow_id || flow.type === 'create_entry') {
      return { ok: true, deleted, recreated: flow };
    }
    const submitRes = await submitConfigFlow(flow.flow_id, { host, port });
    if (!submitRes.ok) {
      reply.code(502);
      return { ok: false, deleted, error: `submit failed: ${submitRes.error ?? submitRes.status}`, body: submitRes.body };
    }
    return {
      ok: true,
      deleted,
      recreated: submitRes.body,
      message: `Removed ${deleted.length} stale Wyoming entry/entries and re-added for ${host}:${port}. Wait a few sec, then check /api/broadcast/tts-debug — tts.piper should now have voice attrs.`,
    };
  },
);

app.post<{ Querystring: { host?: string; port?: string } }>(
  '/api/broadcast/setup-piper',
  { preHandler: requireWriteAuth },
  async (req, reply) => {
    const host = req.query.host ?? 'core-piper';
    const port = Number(req.query.port ?? 10200);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reply.code(400);
      return { ok: false, error: `invalid port: ${req.query.port}` };
    }

    // 1. Check for an existing Wyoming entry that already matches.
    const existing = await listConfigEntries('wyoming');
    if (existing) {
      const match = existing.find((e) => {
        const data = e.data as Record<string, unknown> | undefined;
        return data && data.host === host && Number(data.port) === port;
      });
      if (match) {
        return {
          ok: true,
          alreadyConfigured: true,
          entry: match,
          message: `Wyoming integration for ${host}:${port} already exists. Restart the add-on to refresh TTS detection.`,
        };
      }
    }

    // 2. Start the config flow for `wyoming`.
    const startRes = await startConfigFlow('wyoming');
    if (!startRes.ok) {
      reply.code(startRes.status >= 400 ? startRes.status : 502);
      return {
        ok: false,
        error: `Could not start Wyoming config flow: HTTP ${startRes.status} ${startRes.error ?? ''}. If status is 403, the add-on may lack hassio_api permission — reapprove the add-on permissions in Home Assistant → Settings → Add-ons → Power.`,
        body: startRes.body,
      };
    }
    const flow = startRes.body as { flow_id?: string; type?: string; errors?: unknown };
    if (!flow.flow_id) {
      reply.code(502);
      return { ok: false, error: 'config flow response missing flow_id', body: flow };
    }
    if (flow.type === 'create_entry') {
      // Single-step flow auto-completed.
      return { ok: true, autoCompleted: true, entry: flow };
    }

    // 3. Submit step 1 (host + port).
    const submitRes = await submitConfigFlow(flow.flow_id, { host, port });
    if (!submitRes.ok) {
      reply.code(submitRes.status >= 400 ? submitRes.status : 502);
      return {
        ok: false,
        error: `Wyoming flow submission failed: HTTP ${submitRes.status} ${submitRes.error ?? ''}`,
        body: submitRes.body,
      };
    }
    const final = submitRes.body as { type?: string; title?: string; errors?: unknown };
    if (final.type === 'create_entry') {
      return {
        ok: true,
        created: true,
        title: final.title,
        message: 'Wyoming integration added. The tts.piper entity should appear within a few seconds. Re-test the broadcast to see Piper in the engine list.',
      };
    }
    // Flow returned another step (unusual for Wyoming) — return the form
    // so the caller can complete it.
    return {
      ok: false,
      requiresMoreSteps: true,
      flow_id: flow.flow_id,
      step: final,
      message: 'Wyoming config flow returned another step. Check Home Assistant logs.',
    };
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
app.get('/api/broadcast/discover', { preHandler: requireWriteAuth }, async (_req, reply) => {
  const cfg = broadcast.config();
  const status = broadcast.status();
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
  return {
    supervised: true,
    count: speakers.length,
    speakers,
    // v0.9.70 — speakerGroups + ttsEngine dropped (no more protocol
    // bucketing, no more multi-engine picker — Wyoming is the path).
    musicAssistantAvailable: status.musicAssistantAvailable,
    wyomingReachable: status.wyomingReachable,
  };
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

// v0.60.0 — survive a transient DNS/network bounce (the daily CoreDNS/AppArmor
// maintenance window crashed the add-on with exit 255) but re-raise a genuinely
// fatal uncaught error. Covers the POST-BOOT steady-state runtime (where a transient
// DNS error can leak out of the MQTT client's reconnect path as an unhandled
// rejection); boot-time DNS transients are already handled by the cert-fetch retry
// (getMqttCertificationWithRetry), and a genuine boot-time crash is correctly fatal.
installProcessGuards({
  error: (m) => app.log.error(m),
  fatal: (m) => app.log.fatal(m),
});

const shutdown = async () => {
  app.log.info('shutting down');
  stopPoll();
  clearInterval(ghiPersistTick);
  stopMqtt?.();
  monitor.stop();
  stopTelnet?.();
  stopTuiData(); // shared TUI refresh timers (telnet + /console)
  stopMqttDiscovery?.();
  analytics.stop();
  broadcast.stop();
  recorder.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
