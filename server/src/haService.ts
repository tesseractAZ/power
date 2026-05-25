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
