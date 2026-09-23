import { request } from 'undici';
import { config } from '../config.js';
import { buildQuery, signRequest } from './sign.js';
import { noteServerDate, noteTimestampRejection, signingNowMs, currentOffsetMs } from './clockOffset.js';

export interface EcoFlowResponse<T> {
  code: string; // "0" = success
  message: string;
  data: T;
  eagleEyeTraceId?: string;
  tid?: string;
}

export interface DeviceListItem {
  sn: string;
  productName?: string;
  deviceName?: string;
  online: number; // 1 = online, 0 = offline
}

export interface MqttCertification {
  certificateAccount: string;
  certificatePassword: string;
  url: string;
  port: string;
  protocol: string; // typically "mqtts"
}

/** v1.69.0 — set by index.ts so an adopted clock correction is visible in the log. */
let onClockSampleRejected: ((reason: string) => void) | null = null;
export function setClockRejectLogger(fn: (reason: string) => void): void { onClockSampleRejected = fn; }
let onClockOffsetAdopted: ((offsetMs: number, previousMs: number) => void) | null = null;
export function setClockOffsetLogger(fn: (offsetMs: number, previousMs: number) => void): void {
  onClockOffsetAdopted = fn;
}

/**
 * v1.179.0 — an explicit per-request bound. undici's own headersTimeout / bodyTimeout default to
 * 300 s — exactly SHP2_READBACK_STALE_MS, the window in which the grid resolver still trusts a
 * panel reading — and startPollLoop awaits refreshAll over every device, so ONE hung request
 * held the whole poll for 300 s and aged the panel's reading out of the window (the add-on log
 * shows a 540 s /device/list gap). A timeout here is an ordinary poll failure, retried on the
 * next cycle, so the ~60 s cadence the window assumes holds.
 */
export const ECOFLOW_REST_TIMEOUT_MS = 30_000;

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, params?: Record<string, unknown>): Promise<T> {
  const headers = signRequest({
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    params: method === 'GET' ? params : params,
    nowMs: signingNowMs(), // v1.69.0 — corrected against the server clock
  });
  const url =
    method === 'GET'
      ? `${config.apiHost}${path}${buildQuery(params)}`
      : `${config.apiHost}${path}`;
  const body = method !== 'GET' && params ? JSON.stringify(params) : undefined;

  const reqHeaders: Record<string, string> = { ...headers };
  if (method !== 'GET') reqHeaders['Content-Type'] = 'application/json;charset=UTF-8';
  const reqStartedMs = Date.now(); // v1.81.0 — RTT for the clock-sample gate
  const res = await request(url, {
    method, headers: reqHeaders, body,
    headersTimeout: ECOFLOW_REST_TIMEOUT_MS, bodyTimeout: ECOFLOW_REST_TIMEOUT_MS,
  });
  // v1.69.0 — learn the server clock from EVERY response, including error responses.
  // The 8521 "signature is wrong" rejection carries a Date header too, so the very
  // first rejection teaches us the offset and the NEXT request signs correctly. That
  // turns a 22-minute blind outage into a one-poll-cycle blip.
  const before = currentOffsetMs();
  const dateHeader = (res.headers as Record<string, string | string[] | undefined>)['date'] as string | undefined;
  const rttMs = Date.now() - reqStartedMs;
  const upd = noteServerDate(dateHeader, Date.now(), rttMs);
  if (upd.adopted) {
    onClockOffsetAdopted?.(upd.offsetMs, before);
  } else if (upd.rejected === 'rtt-inflated') {
    // v1.86.0 — the gate's rejections were silent, making "gate never needed"
    // and "gate silently rejecting" indistinguishable in production. Rare by
    // construction (unlike within-deadband), so one line each is cheap.
    onClockSampleRejected?.('rtt-inflated');
  }
  const text = await res.body.text();
  let parsed: EcoFlowResponse<T>;
  try {
    parsed = JSON.parse(text) as EcoFlowResponse<T>;
  } catch {
    throw new Error(`EcoFlow API non-JSON response (status ${res.statusCode}): ${text.slice(0, 200)}`);
  }
  if (parsed.code !== '0' && parsed.code !== 0 + ('' as any)) {
    // v1.109.0 — a timestamp-class rejection (8521 signature / 8524 timestamp)
    // is the vendor telling us our signing clock is WRONG; feed its Date header
    // back with the deadband bypassed so recovery takes one poll, not six
    // minutes of "within-deadband" stalemate (2026-08-25 02:46 incident).
    if (String(parsed.code) === '8521' || String(parsed.code) === '8524') {
      const b2 = currentOffsetMs();
      const u2 = noteTimestampRejection(dateHeader, Date.now(), rttMs);
      if (u2.adopted) onClockOffsetAdopted?.(u2.offsetMs, b2);
    }
    throw new Error(`EcoFlow API error ${parsed.code}: ${parsed.message} (trace ${parsed.eagleEyeTraceId || 'n/a'})`);
  }
  // v1.171.1 — a code-0 reply with NO payload is the vendor answering "success" with
  // nothing (seen 2026-09-20 09:06 across all five Cores at once, under latency). Left
  // unchecked it returned undefined and surfaced as a TypeError naming a BMS field deep
  // inside the projector — indistinguishable from a device fault — and, worse, it was
  // cached as the device's raw quota (see snapshot.ts setDeviceQuota).
  // ★★★ v1.171.2 — READS ONLY. A WRITE (PUT) legitimately answers code 0 with no data:
  // v1.171.1 applied this to every call, so every panel write since was reported as
  // FAILED although it took effect — the 2026-09-21 05:05 reserve revert reached the
  // panel (it read 16%) yet failed 15 times, escalated, and spoke a false CRITICAL.
  if (method !== 'PUT' && parsed.data == null) {
    throw new Error(`EcoFlow API returned success (code 0) with no data payload for ${path}`);
  }
  return parsed.data;
}

export const ecoflow = {
  listDevices: () => call<DeviceListItem[]>('GET', '/iot-open/sign/device/list'),
  getQuotaAll: (sn: string) => call<Record<string, unknown>>('GET', '/iot-open/sign/device/quota/all', { sn }),
  /** Single-quota endpoint — works for some devices that block /quota/all (returns only requested keys). */
  getQuotaSpecific: (sn: string, quotas: string[]) =>
    call<Record<string, unknown>>('POST', '/iot-open/sign/device/quota', { sn, params: { quotas } }),
  /** v1.82.0 — the PD303 historical-data endpoint (documented 2026-08-17):
   *  daily/weekly energy series by flow (home/grid/solar/generator/battery)
   *  and per-circuit split by source. READ-only despite the POST verb. */
  getQuotaData: (sn: string, params: Record<string, unknown>) =>
    call<unknown>('POST', '/iot-open/sign/device/quota/data', { sn, params }),
  getMqttCertification: () => call<MqttCertification>('GET', '/iot-open/sign/certification'),
  /**
   * v0.9.6 — WRITE-side: send an arbitrary command to a device.
   *
   * The EcoFlow IoT Open API uses POST `/iot-open/sign/device/quota` for
   * BOTH reads (when body contains `params.quotas`) and writes (when body
   * contains `cmdSet`/`cmdId` or `moduleType`/`operateType`). This helper
   * is the write entry point — it forwards the body as-is so callers can
   * try whatever command shape the EcoFlow docs (or empirical probing)
   * suggest for their specific device family.
   *
   * Returns the raw `data` field of the EcoFlow response. The signing
   * `call()` already throws on non-zero `code` so the caller doesn't
   * need to inspect for failure beyond catching.
   */
  sendCommand: (sn: string, body: Record<string, unknown>) =>
    call<unknown>('PUT', '/iot-open/sign/device/quota', { sn, ...body }),
};
