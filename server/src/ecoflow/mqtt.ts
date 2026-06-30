import mqtt, { MqttClient } from 'mqtt';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ecoflow, type MqttCertification } from './rest.js'; // v0.10.4 — type for cert retry helper
import { SnapshotStore } from '../snapshot.js';
import { config } from '../config.js';
import { translateDpuMqtt } from './mqttTranslate.js';
import { makeLogCoalescer } from '../logCoalesce.js';

/**
 * EcoFlow IoT Open MQTT subscriber.
 * - GET /iot-open/sign/certification → broker URL + certificate username/password
 * - Topics (per device): /open/{username}/{sn}/quota (telemetry), .../status (online/offline)
 * - Use a STABLE client_id: EcoFlow caps unique IDs at ~10/day per account.
 *
 * Quota messages are typically deltas: { params: { "k": v, ... } } — we merge into the cached raw quota.
 */

/**
 * Real EcoFlow MQTT message shape (discovered via trace, 2026-05):
 *   { cmdId: number, cmdFunc: number, param: { ... } }
 * The `param` payload uses a different field schema from REST `/quota/all`
 * (e.g. bpInfo[].bpSoc instead of hs_yj751_bms_slave_addr.{N}.soc), so we store
 * MQTT data in a parallel cache rather than trying to merge into REST shape.
 *
 * Some firmwares also use `params` (plural) or wrap under `data` — we accept all.
 */
interface QuotaMessage {
  cmdId?: number;
  cmdFunc?: number;
  param?: Record<string, unknown>;
  params?: Record<string, unknown>;
  data?: { params?: Record<string, unknown>; param?: Record<string, unknown> } | Record<string, unknown>;
  id?: string;
  version?: string;
  timestamp?: number;
}

interface StatusMessage {
  params?: { status?: number };
  status?: number;
}

export interface MqttHandle {
  stop: () => void;
  client: MqttClient;
}

// v0.10.4 — retry the cert HTTPS fetch on transient network errors so a boot-time
// DNS brownout (EAI_AGAIN/ENOTFOUND/ECONNREFUSED/ETIMEDOUT/timeout) no longer aborts
// MQTT start before the mqtt client (with its built-in reconnectPeriod) is created.
export function isTransientNetworkError(e: any): boolean {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e ?? '').toLowerCase();
  return (
    /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(code) ||
    // v0.60.0 — dropped the bare `|network` token. It matched ANY message
    // containing "network" (e.g. "neural network training failed"); harmless for
    // the narrow MQTT cert-fetch retry (real cases match on `code`), but this
    // classifier is now also the process guard's survive/fatal gate, where an
    // over-broad match could MASK a genuine bug. The specific terms cover the real
    // transient cases (EAI_AGAIN/ENOTFOUND/ECONNREFUSED/ETIMEDOUT also carry a code).
    /eai_again|enotfound|econnrefused|etimedout|timeout|connect timeout|fetch failed/i.test(msg)
  );
}

async function getMqttCertificationWithRetry(log: (msg: string) => void): Promise<MqttCertification> {
  // Backoff schedule: 2s, 4s, 8s, 16s, 30s (capped at 30s); throw only after the last attempt.
  const backoffMs = [2000, 4000, 8000, 16000, 30000];
  const attempts = backoffMs.length;
  for (let i = 0; i < attempts; i++) {
    try {
      return await ecoflow.getMqttCertification();
    } catch (e: any) {
      const last = i === attempts - 1;
      if (last || !isTransientNetworkError(e)) throw e;
      const wait = backoffMs[i];
      log(`mqtt: certification fetch failed (${e.message}); retry ${i + 1}/${attempts - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Unreachable: the loop either returns or throws above.
  throw new Error('mqtt: certification retry exhausted');
}

export async function startMqtt(store: SnapshotStore, log: (msg: string) => void): Promise<MqttHandle> {
  log('mqtt: requesting certification');
  const cert = await getMqttCertificationWithRetry(log);
  const username = cert.certificateAccount;
  const password = cert.certificatePassword;
  // Stable client_id derived from access key — same Mac, same id every restart.
  const clientId = `ecoflow-panel-${createHash('sha1').update(config.accessKey).digest('hex').slice(0, 12)}`;
  const protocol = (cert.protocol || 'mqtts').toLowerCase();
  const url = `${protocol}://${cert.url}:${cert.port}`;
  log(`mqtt: connecting to ${url} as ${username} (client_id=${clientId})`);

  const client = mqtt.connect(url, {
    username,
    password,
    clientId,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 5000,
    keepalive: 30,
    rejectUnauthorized: true,
  });

  // EcoFlow's ACL rejects wildcard subscribes ("+/quota"). We must subscribe per-SN.
  // Subscribe to whatever's in the store now, plus re-subscribe whenever the device list changes.
  const subscribed = new Set<string>();
  // EcoFlow's IoT Open API MQTT ACL grants only /quota and /status per device.
  // The /get_reply request-reply topic is NOT authorized, so active polling of
  // silent devices (Delta 3 Plus, River 3 Plus, PowerInsight, EVSE) is impossible
  // through this API — those device classes are app-only.
  const subscribeForSn = (sn: string) => {
    if (subscribed.has(sn)) return;
    subscribed.add(sn); // claim synchronously to coalesce bursts; rollback on error
    const topics = [`/open/${username}/${sn}/quota`, `/open/${username}/${sn}/status`];
    client.subscribe(topics, { qos: 0 }, (err) => {
      if (err) {
        subscribed.delete(sn);
        log(`mqtt: subscribe error for ${sn}: ${err.message}`);
      } else {
        log(`mqtt: subscribed ${sn} (quota+status)`);
      }
    });
  };

  // v0.76.0 — coalesce the reconnect/error/close storm. A DNS brownout drives
  // the client into a tight loop where these three lines repeat in lockstep
  // (one 66-min EAI_AGAIN incident logged 514 duplicate lines). Keep the FIRST
  // occurrence of each distinct line at its original level/format; suppress
  // identical repeats and roll them up periodically. `connect` flushes the
  // pending summary so recovery is a clean, greppable transition.
  const stormLog = makeLogCoalescer(log);

  client.on('connect', () => {
    stormLog.flush(); // emit any suppressed reconnect/error tail before the recovery line
    log('mqtt: connected');
    for (const sn of Object.keys(store.get().devices)) subscribeForSn(sn);
  });

  store.on('change', () => {
    if (!client.connected) return;
    for (const sn of Object.keys(store.get().devices)) subscribeForSn(sn);
  });

  client.on('reconnect', () => stormLog.log('mqtt: reconnecting'));
  client.on('close', () => stormLog.log('mqtt: connection closed'));
  client.on('error', (e) => stormLog.log(`mqtt: error ${e.message}`));

  client.on('message', (topic, payload) => {
    // topic format: /open/{username}/{sn}/{kind}
    const parts = topic.split('/');
    const sn = parts[3];
    const kind = parts[4];
    if (!sn || !kind) return;
    // Env-gated trace: log topic + payload preview for one SN (ECOFLOW_TRACE_SN)
    if (process.env.ECOFLOW_TRACE_SN && sn === process.env.ECOFLOW_TRACE_SN) {
      log(`mqtt-trace ${sn} topic=${topic} bytes=${payload.length} preview=${payload.toString('utf8').slice(0, 400)}`);
    }
    // Temp debug: append full message to file for offline analysis
    if (process.env.ECOFLOW_TRACE_FILE && process.env.ECOFLOW_TRACE_SN === sn) {
      try {
        mkdirSync(dirname(process.env.ECOFLOW_TRACE_FILE), { recursive: true });
        appendFileSync(
          process.env.ECOFLOW_TRACE_FILE,
          JSON.stringify({ ts: Date.now(), topic, payload: payload.toString('utf8') }) + '\n',
        );
      } catch (e: any) {
        log(`mqtt-trace file error: ${e.message}`);
      }
    }
    // Temp debug: print every unique topic shape seen, once
    if (process.env.ECOFLOW_TRACE_TOPICS === '1') {
      const shape = `${kind}|${parts.length}`;
      (globalThis as any).__topicShapesSeen ??= new Set<string>();
      const seen = (globalThis as any).__topicShapesSeen as Set<string>;
      if (!seen.has(shape)) {
        seen.add(shape);
        log(`mqtt-topic-shape kind=${kind} parts=${parts.length} example=${topic} preview=${payload.toString('utf8').slice(0, 200)}`);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      log(`mqtt: non-JSON payload on ${topic}`);
      return;
    }

    if (kind === 'quota') {
      const msg = parsed as QuotaMessage;
      // Prefer the discovered shape: { cmdId, cmdFunc, param: {...} }
      const cmdId: number = typeof msg.cmdId === 'number' ? msg.cmdId : -1;
      const param =
        (msg.param && typeof msg.param === 'object' ? msg.param : undefined) ??
        (msg.params && typeof msg.params === 'object' ? msg.params : undefined) ??
        (msg.data && typeof msg.data === 'object' && 'param' in (msg.data as any)
          ? (msg.data as any).param
          : undefined) ??
        (msg.data && typeof msg.data === 'object' && 'params' in (msg.data as any)
          ? (msg.data as any).params
          : undefined);
      if (!param || typeof param !== 'object') return;
      // Only DPUs publish the cmdId schema we currently translate. For other
      // product families, the message is stored but no REST-schema translation.
      const productName = store.get().devices[sn]?.productName?.toLowerCase() ?? '';
      const translated = productName.includes('delta pro ultra')
        ? translateDpuMqtt(cmdId, param as Record<string, unknown>, store.getRaw(sn))
        : null;
      store.setMqttMessage(sn, cmdId, param as Record<string, unknown>, translated);
    } else if (kind === 'status') {
      const msg = parsed as StatusMessage;
      const status = msg.params?.status ?? msg.status;
      if (typeof status === 'number') {
        store.setDeviceOnline(sn, status === 1);
      }
    }
  });

  return {
    client,
    stop: () => {
      try {
        client.end(true);
      } catch {
        /* ignore */
      }
    },
  };
}
