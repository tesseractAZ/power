import { request } from 'undici';
import { config } from '../config.js';
import { buildQuery, signRequest } from './sign.js';

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

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, params?: Record<string, unknown>): Promise<T> {
  const headers = signRequest({
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    params: method === 'GET' ? params : params,
  });
  const url =
    method === 'GET'
      ? `${config.apiHost}${path}${buildQuery(params)}`
      : `${config.apiHost}${path}`;
  const body = method !== 'GET' && params ? JSON.stringify(params) : undefined;

  const reqHeaders: Record<string, string> = { ...headers };
  if (method !== 'GET') reqHeaders['Content-Type'] = 'application/json;charset=UTF-8';
  const res = await request(url, { method, headers: reqHeaders, body });
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
  getMqttCertification: () => call<MqttCertification>('GET', '/iot-open/sign/certification'),
};
