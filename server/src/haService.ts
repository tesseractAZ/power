/**
 * v0.9.18 — Home Assistant service-call helper.
 *
 * When this add-on runs inside Home Assistant Supervisor, the
 * environment provides `SUPERVISOR_TOKEN` — a short-lived bearer
 * granting access to Core's REST API via `http://supervisor/core/api`.
 *
 * We use this to call services on the user's behalf:
 *   - `media_player.play_media`  (HomePod, Sonos, Apple TV, …)
 *   - `media_player.volume_set`
 *   - `sonos.snapshot` / `sonos.restore`  (so we don't clobber music)
 *   - `tts.SERVICE`               (optional verbal announcement)
 *
 * Outside the Supervisor environment (e.g. running the server locally
 * for dev) every call is a no-op that returns `{ ok: false, error }`
 * so the rest of the code path still works without crashing.
 */

import { request } from 'undici';

const SUPERVISOR_BASE = 'http://supervisor/core/api';

export interface ServiceCallResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** Raw response body (debug). */
  body?: string;
}

function token(): string | null {
  const t = process.env.SUPERVISOR_TOKEN;
  return t && t.length > 0 ? t : null;
}

/** Returns true if we're running in a Supervisor-managed environment. */
export function isSupervised(): boolean {
  return token() !== null;
}

/**
 * Call a Home Assistant service.
 *
 *   await callHaService('media_player', 'play_media', {
 *     entity_id: 'media_player.living_room',
 *     media_content_id: 'http://homeassistant.local:8787/audio/red-alert.wav',
 *     media_content_type: 'music',
 *   });
 *
 * If `data.entity_id` is an array, HA fans it out to every entity in one
 * call — cleaner than looping.
 */
export async function callHaService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<ServiceCallResult> {
  const t = token();
  if (!t) return { ok: false, error: 'SUPERVISOR_TOKEN not set (running outside Home Assistant?)' };
  const url = `${SUPERVISOR_BASE}/services/${domain}/${service}`;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    const body = await res.body.text();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, status: res.statusCode, body };
    }
    // v0.9.21 — surface HA's actual error message instead of just the
    // status code. HA typically returns a JSON body like
    // {"message":"Service not found"} or
    // {"message":"unable to fetch http://homeassistant.local:8787/audio/..."}
    // The body is the actionable signal — the status code alone is useless.
    let detail = '';
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) detail = `: ${parsed.message}`;
    } catch {
      // Not JSON — include the first 200 chars of the raw body.
      if (body) detail = `: ${body.slice(0, 200)}`;
    }
    return { ok: false, status: res.statusCode, error: `HA returned ${res.statusCode}${detail}`, body };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Convenience — fetch the state of an entity. Returns `null` if HA
 * doesn't know it (or we're not supervised).
 */
export async function getEntityState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await request(`${SUPERVISOR_BASE}/states/${entityId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    const parsed = JSON.parse(body) as { state: string; attributes: Record<string, unknown> };
    return parsed;
  } catch {
    return null;
  }
}

/** Whether the given entity ID actually exists in HA. Useful at startup. */
export async function entityExists(entityId: string): Promise<boolean> {
  return (await getEntityState(entityId)) !== null;
}

/**
 * v0.9.23 — fetch the HA service catalog. Used to detect whether
 * Music Assistant is installed (presence of music_assistant.play_announcement)
 * so the broadcast loop can prefer its purpose-built announce service
 * over the slower-and-serialized media_player.play_media path.
 *
 * Returns null when not supervised. Returns the raw catalog otherwise —
 * an array of { domain: string, services: Record<string, ServiceDescriptor> }.
 */
export async function getServiceCatalog(): Promise<Array<{ domain: string; services: Record<string, unknown> }> | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await request(`${SUPERVISOR_BASE}/services`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    return JSON.parse(body) as Array<{ domain: string; services: Record<string, unknown> }>;
  } catch {
    return null;
  }
}

/** True if `<domain>.<service>` exists in the catalog. */
export async function hasService(domain: string, service: string): Promise<boolean> {
  const cat = await getServiceCatalog();
  if (!cat) return false;
  const d = cat.find((c) => c.domain === domain);
  if (!d) return false;
  return service in d.services;
}

/**
 * v0.9.19 — fetch all entity states. Used by the broadcast-discovery
 * endpoint to enumerate every media_player HA knows about, so the
 * user can pick targets from a real list instead of guessing entity IDs.
 */
export async function getAllStates(): Promise<Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }> | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await request(`${SUPERVISOR_BASE}/states`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    return JSON.parse(body) as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  } catch {
    return null;
  }
}

/* ─── v0.9.33 — Supervisor add-on API + Core config-flow helpers ───────── */

const SUPERVISOR_ADDONS_BASE = 'http://supervisor';
const SUPERVISOR_CONFIG_FLOW = `${SUPERVISOR_BASE}/config/config_entries`;

export interface AddonSummary {
  slug: string;
  name: string;
  version: string | null;
  state: 'started' | 'stopped' | 'unknown' | string;
  installed: boolean;
}

/**
 * v0.9.33 — List installed add-ons via Supervisor `/addons`. Requires the
 * `hassio_api: true` permission in config.yaml. Returns null when unavailable
 * (no Supervisor token OR our role is insufficient).
 */
export async function listAddons(): Promise<AddonSummary[] | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await request(`${SUPERVISOR_ADDONS_BASE}/addons`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    const parsed = JSON.parse(body) as { data?: { addons?: Array<Record<string, unknown>> } };
    const addons = parsed.data?.addons ?? [];
    return addons.map((a) => ({
      slug: String(a.slug ?? ''),
      name: String(a.name ?? a.slug ?? ''),
      version: a.version != null ? String(a.version) : null,
      state: String(a.state ?? 'unknown'),
      installed: Boolean(a.installed ?? true),
    }));
  } catch {
    return null;
  }
}

/**
 * v0.9.33 — Look up the existing config-entries for a given integration
 * domain (e.g., "wyoming"). Returns null if Core API is unavailable.
 */
export async function listConfigEntries(domain?: string): Promise<Array<Record<string, unknown>> | null> {
  const t = token();
  if (!t) return null;
  try {
    const url = domain
      ? `${SUPERVISOR_CONFIG_FLOW}?domain=${encodeURIComponent(domain)}`
      : SUPERVISOR_CONFIG_FLOW;
    const res = await request(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${t}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * v0.9.33 — Start a Core config-flow for an integration. Returns the
 * flow handle (the next step's form schema, or `create_entry` on
 * single-step flows).
 *
 * HA config flows are multi-step: this kicks off step 1. Caller must
 * follow up with `submitConfigFlow(flow_id, formData)` for step 2 etc.
 *
 * Used by /api/broadcast/setup-piper to add the Wyoming Protocol
 * integration without making the operator click through Settings → Devices.
 */
export async function startConfigFlow(handler: string, showAdvanced = false): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const t = token();
  if (!t) return { ok: false, status: 0, body: null, error: 'SUPERVISOR_TOKEN not set' };
  try {
    const res = await request(`${SUPERVISOR_CONFIG_FLOW}/flow`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ handler, show_advanced_options: showAdvanced }),
    });
    const bodyText = await res.body.text();
    let body: unknown = bodyText;
    try { body = JSON.parse(bodyText); } catch { /* leave raw */ }
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      body,
    };
  } catch (e: any) {
    return { ok: false, status: 0, body: null, error: String(e?.message ?? e) };
  }
}

/**
 * v0.9.33 — Submit a form step to an in-flight config flow. The flow_id
 * comes from the previous startConfigFlow/submitConfigFlow response.
 */
export async function submitConfigFlow(flowId: string, formData: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const t = token();
  if (!t) return { ok: false, status: 0, body: null, error: 'SUPERVISOR_TOKEN not set' };
  try {
    const res = await request(`${SUPERVISOR_CONFIG_FLOW}/flow/${encodeURIComponent(flowId)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
    const bodyText = await res.body.text();
    let body: unknown = bodyText;
    try { body = JSON.parse(bodyText); } catch { /* leave raw */ }
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      body,
    };
  } catch (e: any) {
    return { ok: false, status: 0, body: null, error: String(e?.message ?? e) };
  }
}
