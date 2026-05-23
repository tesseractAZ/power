import mqtt, { MqttClient } from 'mqtt';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ecoflow } from './rest.js';
import { SnapshotStore } from '../snapshot.js';
import { config } from '../config.js';
import { translateDpuMqtt } from './mqttTranslate.js';

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

export async function startMqtt(store: SnapshotStore, log: (msg: string) => void): Promise<MqttHandle> {
  log('mqtt: requesting certification');
  const cert = await ecoflow.getMqttCertification();
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

  client.on('connect', () => {
    log('mqtt: connected');
    for (const sn of Object.keys(store.get().devices)) subscribeForSn(sn);
  });

  store.on('change', () => {
    if (!client.connected) return;
    for (const sn of Object.keys(store.get().devices)) subscribeForSn(sn);
  });

  client.on('reconnect', () => log('mqtt: reconnecting'));
  client.on('close', () => log('mqtt: connection closed'));
  client.on('error', (e) => log(`mqtt: error ${e.message}`));

  client.on('message', (topic, payload) => {
    // topic format: /open/{username}/{sn}/{kind}
    const parts = topic.split('/');
    const sn = parts[3];
    const kind = parts[4];
    if (!sn || !kind) return;
    // Temp debug: log first byte+topic for EVSE specifically
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
