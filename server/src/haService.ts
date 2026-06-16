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
  // v0.9.57 — cap stalled HA service calls so a hung integration doesn't
  //   block the broadcast pipeline indefinitely (undici default is ~5 min).
  // v0.9.72 — Music Assistant's `play_announcement` is a synchronous
  //   service that doesn't return until the announce has been queued AND
  //   started on every target — measured at ~9 s for a 5-speaker, 271-KB
  //   combined-WAV announcement. The previous 5 s / 10 s cap aborted
  //   every broadcast with "Headers Timeout" even though the audio was
  //   playing on the speakers (verified end-to-end via the same call
  //   from curl with 30 s timeout). Everything else stays tight to keep
  //   hangs visible.
  // v0.15.10 — the v0.15.4 repeat (BROADCAST_REPEAT=2) + inter-repeat gap
  //   render the whole annunciation into ONE WAV that is now ~2.2 MB / ~24 s
  //   of audio (vs the 271 KB the 30 s cap was sized for). On slow ecobee
  //   speakers MA didn't return headers within 30 s → the broadcast logged
  //   `partial` with "Headers Timeout Error" even though the audio likely
  //   played. Raise the announce ceiling to 75 s / 120 s so a long repeated
  //   announcement to slow targets completes rather than aborting partial.
  const isMaAnnounce = domain === 'music_assistant' && service === 'play_announcement';
  const headersTimeoutMs = isMaAnnounce ? 75_000 : 5000;
  const bodyTimeoutMs = isMaAnnounce ? 120_000 : 10_000;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
      headersTimeout: headersTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
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
 * v0.9.80 — three-state service probe. Unlike `hasService` (which can't tell
 * "catalog fetch failed" from "service genuinely absent"), this returns:
 *   - 'present' : catalog fetched AND <domain>.<service> exists
 *   - 'absent'  : catalog fetched successfully but lacked the service
 *   - 'unknown' : catalog fetch failed — Core/Supervisor proxy not ready at
 *                 boot, non-200, etc. The caller must NOT treat this as a
 *                 confirmed negative (that startup race produced the spurious
 *                 "broadcasts will fail until MA is installed" log line).
 */
export async function probeService(
  domain: string,
  service: string,
): Promise<'present' | 'absent' | 'unknown'> {
  const cat = await getServiceCatalog();
  if (!cat) return 'unknown';
  const d = cat.find((c) => c.domain === domain);
  if (!d) return 'absent';
  return service in d.services ? 'present' : 'absent';
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
      // v0.23.0 — bound the request so a hung HA Supervisor can't stall callers.
      // getAllStates now runs inside the 20 s alert-eval loop (grid-presence
      // refresh) and the load-shed tick; without a timeout undici waits ~5 min on
      // a wedged socket. On timeout undici throws → caught below → returns null →
      // the grid resolver falls back to its safe default (grid NOT present).
      headersTimeout: 4000,
      bodyTimeout: 8000,
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    return JSON.parse(body) as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  } catch {
    return null;
  }
}

/* ─── v0.9.40 — TTS-render-to-URL helper ──────────────────────────────── */

export interface TtsUrlResult {
  /** The full URL (including HA base) the speaker should fetch. */
  url: string;
  /** The relative path returned by HA (e.g., `/api/tts_proxy/<hash>.mp3`). */
  path: string;
  /** When the call failed, a human-readable diagnostic (HTTP status + body.message). */
  error?: string;
}

/**
 * v0.9.63 — Flip the separator between hyphen and underscore in a BCP47/POSIX
 * locale tag. Returns the original string unchanged if it has neither.
 *
 * Why: HA's `/api/tts_get_url` is strict about locale format, and the
 * expectation depends on which TTS engine is wired up:
 *   - Wyoming-based engines (Piper, etc.) want POSIX (`en_US`)
 *   - HA Cloud TTS wants BCP47 (`en-US`)
 *   - Both also accept the parameter being omitted (use engine default)
 * Empirically verified: passing the wrong separator yields a 500. The
 * fallback chain in `ttsGetUrl` toggles via this helper before giving
 * up entirely.
 */
export function toggleLocaleSeparator(lang: string): string {
  if (lang.includes('-')) return lang.replace(/-/g, '_');
  if (lang.includes('_')) return lang.replace(/_/g, '-');
  return lang;
}

/**
 * v0.9.63 — Minimal shape of undici's `request` we care about. Exposed so
 * tests can inject a stub without pulling in the full undici dispatcher
 * surface. Real undici returns more fields; we only read `statusCode`
 * and `body.text()`.
 */
export type TtsRequestFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    headersTimeout?: number;
    bodyTimeout?: number;
  },
) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;

/**
 * v0.9.40 — Render TTS to a URL via HA's `/api/tts_get_url` endpoint
 * WITHOUT playing it. The returned URL can then be passed to
 * `music_assistant.play_announcement` (or any other audio-playing
 * service) — this bypasses the `tts.speak` → `media_player` direct
 * binding that conflicts with MA's speaker ownership.
 *
 * Background: the operator's setup has MA-managed speakers. After MA plays
 * the klaxon, the speakers remain in MA's session. `tts.speak`
 * subsequently hangs trying to acquire them. By rendering TTS to a
 * URL and playing via MA's own `play_announcement`, we avoid the
 * conflict entirely — MA always owns the speakers, MA always plays.
 *
 * v0.9.49 — Returns `{ error }` instead of `null` on failure so the
 * caller can distinguish "no SUPERVISOR_TOKEN" vs "engine_id not
 * found" vs "HA returned 500". Log analyst found every Piper render
 * silently returned null with no clue why; users had no diagnostic
 * path. Now the orchestrator surfaces the upstream error verbatim.
 *
 * v0.9.63 — When HA returns 500 on the first attempt, retry up to two
 * more times with progressively more-permissive language formats:
 *
 *   1. as-given     — exactly the language string the caller passed
 *   2. toggled      — hyphen ↔ underscore (`en-US` ↔ `en_US`)
 *   3. no-language  — drop `body.language` entirely (engine default)
 *
 * Empirically `tts.piper` (Wyoming) wants POSIX (`en_US`), while
 * `tts.home_assistant_cloud` wants BCP47 (`en-US`); both 500 on the
 * wrong format. Trying all three on 500 means the broadcast monitor
 * succeeds even when `BROADCAST_TTS_LANGUAGE` is set to the format
 * the OTHER engine prefers. On non-500 (4xx) we fail fast — wrong
 * separator isn't going to fix a missing engine_id.
 *
 * On success via fallback, `log` is invoked with a one-liner so the operator
 * can see "Piper worked, but only after the underscore retry — set
 * `BROADCAST_TTS_LANGUAGE: en_US` in config.yaml" in the add-on log.
 *
 * `requestFn` is injectable so the retry chain can be unit-tested
 * without standing up a fake HTTP server.
 */
export async function ttsGetUrl(
  engineEntityId: string,
  message: string,
  language: string | null = null,
  externalBaseUrl: string | null = null,
  log: (m: string) => void = () => {},
  requestFn: TtsRequestFn = request as unknown as TtsRequestFn,
): Promise<TtsUrlResult> {
  const t = token();
  if (!t) {
    return { url: '', path: '', error: 'SUPERVISOR_TOKEN not set (not supervised)' };
  }

  type AttemptResult =
    | { ok: true; statusCode: number; bodyText: string }
    | { ok: false; statusCode: number; error: string };

  const tryRender = async (lang: string | undefined): Promise<AttemptResult> => {
    const body: Record<string, unknown> = {
      engine_id: engineEntityId,
      message,
      cache: true,
    };
    if (lang) body.language = lang;
    try {
      // v0.9.57 — render timeout. Piper on a Pi takes ~1-3s for a short
      // utterance; Cloud TTS is sub-second. 4s headers / 8s body lets
      // slow Piper renders complete but bails on a hung integration so
      // the engine fallback chain in broadcast.ts can move to Cloud.
      const res = await requestFn(`${SUPERVISOR_BASE}/tts_get_url`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${t}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        headersTimeout: 4000,
        bodyTimeout: 8000,
      });
      const bodyText = await res.body.text();
      if (res.statusCode === 200) {
        return { ok: true, statusCode: 200, bodyText };
      }
      // v0.9.49 — Surface HA's actual error. Same pattern as v0.9.21
      // callHaService — body is typically {"message":"..."}; if not
      // JSON, include first 200 chars of raw response.
      let detail = '';
      try {
        const parsed = JSON.parse(bodyText) as { message?: string };
        if (parsed.message) detail = `: ${parsed.message}`;
      } catch {
        if (bodyText) detail = `: ${bodyText.slice(0, 200)}`;
      }
      return {
        ok: false,
        statusCode: res.statusCode,
        error: `HA ${res.statusCode}${detail}`,
      };
    } catch (e: any) {
      return { ok: false, statusCode: 0, error: `threw: ${String(e?.message ?? e)}` };
    }
  };

  // Build the dedup'd attempt chain.
  const attempts: { label: string; lang: string | undefined }[] = [
    { label: 'as-given', lang: language ?? undefined },
  ];
  if (language) {
    const toggled = toggleLocaleSeparator(language);
    if (toggled !== language) {
      attempts.push({ label: 'toggled', lang: toggled });
    }
    attempts.push({ label: 'no-language', lang: undefined });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    const r = await tryRender(attempt.lang);
    if (r.ok) {
      if (attempt.label !== 'as-given') {
        log(
          `tts_get_url succeeded via ${attempt.label} fallback ` +
            `(engine=${engineEntityId}, lang=${attempt.lang ?? 'none'}) — ` +
            `consider setting BROADCAST_TTS_LANGUAGE to "${attempt.lang ?? '(empty)'}" ` +
            `to skip the retry next time`,
        );
      }
      const parsed = JSON.parse(r.bodyText) as { url?: string; path?: string };
      if (!parsed.url) {
        return {
          url: '',
          path: '',
          error: `tts_get_url 200 but no url in response body (engine_id=${engineEntityId})`,
        };
      }
      // Decide the absolute URL the speaker will fetch.
      //   - `parsed.url` from HA is relative ("/api/tts_proxy/<hash>.mp3")
      //   - We prefix with the external HA URL so LAN speakers can fetch it.
      //   - If `externalBaseUrl` is provided, use that. Otherwise fall back to
      //     the canonical `http://homeassistant.local:8123` (HA's default).
      const base = (externalBaseUrl ?? 'http://homeassistant.local:8123').replace(/\/$/, '');
      const relativePath = parsed.url.startsWith('/') ? parsed.url : `/${parsed.url}`;
      return {
        url: `${base}${relativePath}`,
        path: parsed.path ?? relativePath,
      };
    }
    errors.push(`${attempt.label}(lang=${attempt.lang ?? 'none'}): ${r.error}`);
    // Only retry on 500 — fail fast on 4xx (engine_id not found,
    // auth, etc.) since toggling the separator won't fix those.
    if (r.statusCode !== 500) break;
  }
  return {
    url: '',
    path: '',
    error: `tts_get_url all attempts failed (engine_id=${engineEntityId}): ${errors.join(' | ')}`,
  };
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
/**
 * v0.9.43 — Delete a Core config-entry by its entry_id. Used by
 * `/api/broadcast/reset-piper` to wipe out a broken Wyoming Protocol
 * integration so it can be re-added cleanly (re-pulling voice metadata
 * from Piper on connect).
 */
export async function deleteConfigEntry(entryId: string): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
  const t = token();
  if (!t) return { ok: false, status: 0, error: 'SUPERVISOR_TOKEN not set' };
  try {
    const res = await request(`${SUPERVISOR_CONFIG_FLOW}/entry/${encodeURIComponent(entryId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${t}` },
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
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
}

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
