import { request } from 'undici';
import { config } from '../config.js';
import { buildQuery, signRequest } from './sign.js';
import { noteServerDate, signingNowMs, currentOffsetMs } from './clockOffset.js';

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
let onClockOffsetAdopted: ((offsetMs: number, previousMs: number) => void) | null = null;
export function setClockOffsetLogger(fn: (offsetMs: number, previousMs: number) => void): void {
  onClockOffsetAdopted = fn;
}

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
  const res = await request(url, { method, headers: reqHeaders, body });
  // v1.69.0 — learn the server clock from EVERY response, including error responses.
  // The 8521 "signature is wrong" rejection carries a Date header too, so the very
  // first rejection teaches us the offset and the NEXT request signs correctly. That
  // turns a 22-minute blind outage into a one-poll-cycle blip.
  const before = currentOffsetMs();
  const upd = noteServerDate(
    (res.headers as Record<string, string | string[] | undefined>)['date'] as string | undefined,
    Date.now(),
    Date.now() - reqStartedMs,
  );
  if (upd.adopted) {
    onClockOffsetAdopted?.(upd.offsetMs, before);
  }
  const text = await res.body.text();
  let parsed: EcoFlowResponse<T>;
  try {
    parsed = JSON.parse(text) as EcoFlowResponse<T>;
  } catch {
    throw new Error(`EcoFlow API non-JSON response (status ${res.statusCode}): ${text.slice(0, 200)}`);
  }
  if (parsed.code !== '0' && parsed.code !== 0 + ('' as any)) {
    throw new Error(`EcoFlow API error ${parsed.code}: ${parsed.message} (trace ${parsed.eagleEyeTraceId ?? 'n/a'})`);
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
