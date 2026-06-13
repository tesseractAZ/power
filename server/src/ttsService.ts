/**
 * v0.9.29 — TTS auto-detection + message synthesis for ship-wide broadcasts.
 *
 * Before this release the broadcast pipeline only played a klaxon WAV.
 * Operators across the property heard "BEEP BEEP BEEP" and had to walk
 * to a screen to find out what was actually wrong. The user reasonably
 * pointed out that this is exactly the failure mode you cannot afford
 * in a real off-grid system: alarms have to be self-describing.
 *
 * This module:
 *
 *   1. Detects which TTS engines Home Assistant exposes (Piper, Cloud,
 *      Google Translate Say, ElevenLabs).
 *   2. Picks the best available by quality + reliability — Piper > Cloud
 *      > Google > ElevenLabs (only because EL requires per-char billing;
 *      if the user explicitly picks it we honor that).
 *   3. Builds a clear, hearable announcement from an Alert struct —
 *      severity prefix, category, device, then the human-readable detail.
 *      Numbers get spelled out (Piper handles "5%" fine but Google sometimes
 *      reads it as "five percent sign" — we normalize defensively).
 *   4. Fires the TTS service via callHaService, routing through Music
 *      Assistant when available (MA handles multi-speaker TTS sync better
 *      than tts.speak which only targets one entity at a time).
 *
 * The user can override the auto-pick by setting BROADCAST_TTS_SERVICE
 * to a specific HA service ID — that's checked FIRST and only falls
 * through to auto-detection when empty/missing.
 *
 * Note on cache=true: every modern HA TTS service accepts a `cache`
 * flag that stores rendered audio for ~30 days. Same message → instant
 * playback on repeat. We pass cache: true on every call.
 */

import { getServiceCatalog, hasService, callHaService, getAllStates, ttsGetUrl, type ServiceCallResult } from './haService.js';
import type { Alert } from './alerts.js';
import { priorityOf, priorityAnnouncementPrefix } from './alertPriority.js';

/* ─── service detection ──────────────────────────────────────────── */

/** A TTS engine we know how to call. Ordered by quality + suitability
 *  for this off-grid, alert-heavy use case. */
export interface TtsEngine {
  /** HA service ID — domain.service form. e.g. "tts.piper" */
  service: string;
  /** Human-friendly label for UI / logs. */
  label: string;
  /** True if local (no internet required). Off-grid systems prefer local. */
  local: boolean;
  /** Quality tier (1=best). Pure subjective: Piper~Cloud > Google > etc. */
  quality: number;
}

/** Known engines we'll auto-detect, in preference order. */
const KNOWN_ENGINES: TtsEngine[] = [
  // Piper — local, free, fast, off-grid-safe. THE pick for this user.
  { service: 'tts.piper',                 label: 'Piper (local)',          local: true,  quality: 1 },
  // Nabu Casa Cloud TTS — subscription, very good voices, fast.
  { service: 'tts.cloud_say',             label: 'HA Cloud (Nabu Casa)',   local: false, quality: 1 },
  // ElevenLabs — premium voices, but per-char billing.
  { service: 'tts.elevenlabs_say',        label: 'ElevenLabs',             local: false, quality: 1 },
  // Google Translate Say — free, decent quality, internet required.
  { service: 'tts.google_translate_say',  label: 'Google Translate Say',   local: false, quality: 2 },
  // Microsoft Edge TTS — local-ish (uses internet but free).
  { service: 'tts.edge_tts_say',          label: 'Microsoft Edge TTS',     local: false, quality: 2 },
  // Generic tts.speak (the newer unified service — accepts any tts entity).
  // This is the modern way; engine-specific services are legacy.
  { service: 'tts.speak',                 label: 'tts.speak (any engine)', local: true,  quality: 2 },
];

/**
 * v0.9.31 — Detect TTS ENTITIES (not just services).
 *
 * Modern HA (2023+) exposes each TTS engine as an entity like
 * `tts.home_assistant_cloud`, `tts.piper`, `tts.google_translate_say`.
 * The unified service `tts.speak` then takes the entity_id as a target
 * — this is the recommended path going forward; legacy domain-specific
 * services like `tts.cloud_say` are being deprecated and have been
 * observed returning 500 in HA 2026.x for some configurations.
 *
 * We use these entities to:
 *   1. Honor `BROADCAST_TTS_SERVICE=piper` by mapping to the discovered
 *      `tts.piper` entity even when the legacy `tts.piper` service is gone.
 *   2. Surface a richer picker UI: every engine is callable.
 */
export interface TtsEntity {
  entity_id: string;     // tts.home_assistant_cloud
  friendly_name: string;
  /** Inferred from entity_id pattern (best-effort). */
  flavor: 'piper' | 'cloud' | 'google' | 'elevenlabs' | 'edge' | 'other';
}

export async function detectTtsEntities(): Promise<TtsEntity[]> {
  const all = await getAllStates();
  if (!all) return [];
  const entities: TtsEntity[] = [];
  for (const s of all) {
    if (!s.entity_id.startsWith('tts.')) continue;
    const id = s.entity_id.toLowerCase();
    const attrs = s.attributes ?? {};
    // v0.9.32 — also check the integration / engine attribute. Piper via
    // Wyoming exposes itself with attrs like `engine: "piper"` even when
    // the entity_id is something generic like `tts.home_assistant`.
    const engineAttr = String((attrs as Record<string, unknown>).engine ?? '').toLowerCase();
    const friendly = String((attrs as Record<string, unknown>).friendly_name ?? s.entity_id).toLowerCase();
    let flavor: TtsEntity['flavor'] = 'other';
    if (id.includes('piper') || engineAttr.includes('piper') || friendly.includes('piper') || friendly.includes('wyoming')) flavor = 'piper';
    else if (id.includes('cloud') || id.includes('home_assistant_cloud') || id.includes('nabu') || engineAttr.includes('cloud')) flavor = 'cloud';
    else if (id.includes('google') || engineAttr.includes('google')) flavor = 'google';
    else if (id.includes('elevenlabs') || engineAttr.includes('elevenlabs')) flavor = 'elevenlabs';
    else if (id.includes('edge') || engineAttr.includes('edge')) flavor = 'edge';
    entities.push({
      entity_id: s.entity_id,
      friendly_name: String((s.attributes ?? {}).friendly_name ?? s.entity_id),
      flavor,
    });
  }
  return entities;
}

/**
 * v0.9.32 — Diagnostic dump for the /api/broadcast/tts-debug endpoint.
 *
 * Field testing of v0.9.31 against the operator's Home Assistant turned up only
 * `tts.cloud_say` even though Piper add-on was running. The likely cause
 * is the Wyoming Protocol integration hadn't been added in HA, so no
 * `tts.*` entity was published. This endpoint returns the raw evidence
 * so we can confirm vs guess.
 */
export interface TtsDebugInfo {
  supervised: boolean;
  /** All services in the `tts` domain from HA's service catalog. */
  ttsServices: string[];
  /** Every entity whose entity_id starts with `tts.` — raw shape. */
  ttsEntities: Array<{
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
  }>;
  /** Computed engine list after our flavor+dedup logic. */
  detectedEngines: TtsEngine[];
  /** Helpful guidance for common gotchas. */
  hints: string[];
}

export async function getTtsDebug(): Promise<TtsDebugInfo> {
  const hints: string[] = [];
  const cat = await getServiceCatalog();
  if (!cat) {
    return {
      supervised: false,
      ttsServices: [],
      ttsEntities: [],
      detectedEngines: [],
      hints: ['Not supervised (SUPERVISOR_TOKEN missing). Run as a HA add-on.'],
    };
  }
  const ttsDomain = cat.find((c) => c.domain === 'tts');
  const ttsServices = ttsDomain ? Object.keys(ttsDomain.services) : [];
  const all = await getAllStates();
  const ttsEntities = (all ?? []).filter((s) => s.entity_id.startsWith('tts.')).map((s) => ({
    entity_id: s.entity_id,
    state: s.state,
    attributes: s.attributes ?? {},
  }));
  const detectedEngines = await detectTtsEngines();

  // Heuristic hints — emit one per missing-piece we can detect.
  if (ttsServices.length === 0) {
    hints.push('No tts.* services exposed. Check Home Assistant logs for TTS integration errors.');
  }
  if (!ttsServices.includes('speak')) {
    hints.push('tts.speak (the unified service) is missing. Are you on HA 2023.0+? Modern TTS uses this.');
  }
  if (ttsEntities.length === 0) {
    hints.push('No tts.* ENTITIES found. If Piper add-on is running, you also need: Settings → Devices & services → Add Integration → "Wyoming Protocol" → host=core-piper, port=10200. This creates the tts.piper entity.');
  }
  const hasPiper = ttsEntities.some((e) => e.entity_id.toLowerCase().includes('piper') || String(e.attributes.engine ?? '').toLowerCase().includes('piper'));
  const hasCloud = ttsEntities.some((e) => e.entity_id.toLowerCase().includes('cloud') || e.entity_id.toLowerCase().includes('nabu'));
  if (!hasPiper && !hasCloud && ttsEntities.length === 0) {
    hints.push('Recommended local TTS engines to install (HA → Settings → Add-ons → Add-on Store):');
    hints.push('  • Piper (Wyoming) — best for off-grid alerts, neural quality, fast');
    hints.push('  • OpenedAI Speech — local OpenAI-API-compatible TTS');
    hints.push('  • Mimic 3 — Mycroft\'s local TTS (less actively maintained)');
  }
  if (detectedEngines.length === 1 && detectedEngines[0].service === 'tts.cloud_say') {
    hints.push('Only HA Cloud detected — broadcast TTS depends on internet and Nabu Casa uptime. Install Piper for an off-grid fallback.');
  }

  return { supervised: true, ttsServices, ttsEntities, detectedEngines, hints };
}

/**
 * Detect which TTS engines are exposed by HA right now. Returns them
 * sorted by quality (best first). Empty when not supervised or when
 * none are installed.
 *
 * v0.9.31: now also synthesizes engines from the discovered TTS entities
 * via `tts.speak`, so a system with only the modern unified service still
 * shows individual engines (Piper, Cloud, etc.) instead of just one
 * generic "tts.speak" entry.
 */
export async function detectTtsEngines(): Promise<TtsEngine[]> {
  const cat = await getServiceCatalog();
  const found: TtsEngine[] = [];
  // 1. Legacy domain-specific services (still work on most setups).
  if (cat) {
    for (const eng of KNOWN_ENGINES) {
      // Skip the generic `tts.speak` here — we'll synthesize one engine
      // per discovered TTS entity below, which is strictly more useful.
      if (eng.service === 'tts.speak') continue;
      const [domain, service] = eng.service.split('.');
      const d = cat.find((c) => c.domain === domain);
      if (d && service in d.services) {
        found.push(eng);
      }
    }
  }
  // 2. Modern unified path: one synthetic engine per discovered TTS entity.
  // v0.9.35 — PREFER modern over legacy. v0.9.30 had legacy `tts.cloud_say`
  // returning 500s in production; the modern `tts.speak:tts.home_assistant_cloud`
  // path uses the same engine but a different HA endpoint that's better
  // maintained. Drop the legacy entry when a matching modern entity exists.
  const entities = await detectTtsEntities();
  const hasTtsSpeak = cat?.some((c) => c.domain === 'tts' && 'speak' in c.services) ?? false;
  if (hasTtsSpeak) {
    for (const ent of entities) {
      const labelMap: Record<TtsEntity['flavor'], string> = {
        piper: 'Piper (local)',
        cloud: 'HA Cloud (Nabu Casa)',
        google: 'Google Translate Say',
        elevenlabs: 'ElevenLabs',
        edge: 'Microsoft Edge TTS',
        other: ent.friendly_name,
      };
      const qualityMap: Record<TtsEntity['flavor'], number> = {
        piper: 1, cloud: 1, elevenlabs: 1, google: 2, edge: 2, other: 3,
      };
      const localMap: Record<TtsEntity['flavor'], boolean> = {
        piper: true, cloud: false, google: false, elevenlabs: false, edge: false, other: false,
      };
      // Encode the entity ref in the service field as "tts.speak:<entity_id>"
      // so callers can route a speak() call through the right entity.
      const serviceRef = `tts.speak:${ent.entity_id}`;
      // v0.9.35 — REMOVE matching legacy entry instead of skipping the
      // modern one. Modern tts.speak path is better maintained; legacy
      // engine-specific services are deprecated and have been observed
      // returning 500s in HA 2026.x.
      const legacyServiceForFlavor: Record<TtsEntity['flavor'], string | null> = {
        piper: 'tts.piper',
        cloud: 'tts.cloud_say',
        google: 'tts.google_translate_say',
        elevenlabs: 'tts.elevenlabs_say',
        edge: 'tts.edge_tts_say',
        other: null,
      };
      const legacyService = legacyServiceForFlavor[ent.flavor];
      if (legacyService) {
        const idx = found.findIndex((f) => f.service === legacyService);
        if (idx >= 0) found.splice(idx, 1);
      }
      found.push({
        service: serviceRef,
        label: labelMap[ent.flavor],
        local: localMap[ent.flavor],
        quality: qualityMap[ent.flavor],
      });
    }
  }
  // Stable sort: quality asc (best first), then local first.
  found.sort((a, b) => a.quality - b.quality || (a.local === b.local ? 0 : a.local ? -1 : 1));
  return found;
}

/**
 * v0.9.31 — Normalize user-supplied TTS preference into a full service ref.
 *
 * Users in the v0.9.30 release wrote `BROADCAST_TTS_SERVICE=piper` (no
 * `tts.` prefix) expecting it to point at Piper, and we silently ignored
 * the preference because it didn't match `tts.piper` exactly. This
 * normalizer accepts the common shorthands:
 *
 *    "piper"       → "tts.piper"      (legacy service, if present)
 *                 OR "tts.speak:tts.piper"  (modern entity-routed)
 *    "tts.piper"   → as written
 *    "cloud"       → "tts.cloud_say" → "tts.speak:tts.home_assistant_cloud"
 *    "tts.cloud_say" → as written
 *
 * Returns null when no engine matches the preference (caller should
 * fall back to auto-pick).
 */
function normalizePreference(preferred: string, engines: TtsEngine[]): TtsEngine | null {
  const pref = preferred.trim().toLowerCase();
  if (!pref) return null;
  // Exact match wins.
  let m = engines.find((e) => e.service.toLowerCase() === pref);
  if (m) return m;
  // tts.<x>:<entity> form — exact compare.
  m = engines.find((e) => e.service.toLowerCase() === pref);
  if (m) return m;
  // Bare flavor name → first engine whose service or label contains it.
  m = engines.find((e) => e.service.toLowerCase().includes(pref) || e.label.toLowerCase().includes(pref));
  if (m) return m;
  return null;
}

/**
 * v0.9.65 — Pure pick logic, separated for testability.
 *
 * Given a list of detected engines and a preference, returns the engine
 * to use (or null). Honors `requireLocal` by filtering the candidate
 * pool to engines where `local === true` BEFORE matching preference.
 *
 * Behavior matrix:
 *
 *   | preferred set | requireLocal | result                                       |
 *   |---------------|--------------|----------------------------------------------|
 *   | yes, matches  | false        | matched engine (existing behavior)           |
 *   | yes, matches  | true         | matched engine IFF it's local; else null     |
 *   | yes, no match | false        | null (caller may try the unknown-svc escape) |
 *   | yes, no match | true         | null (escape hatch disabled — can't prove    |
 *   |               |              |   locality of an unknown service)            |
 *   | no            | false        | engines[0] (highest quality)                 |
 *   | no            | true         | first local engine; null if none             |
 *
 * Separated from `pickBestEngine` (which still pulls from HA via
 * `detectTtsEngines`) so the v0.9.65 filtering rules can be unit-tested
 * without standing up a fake HA supervisor.
 */
export function pickEngineFromList(
  engines: TtsEngine[],
  preferred: string | null,
  requireLocal = false,
): TtsEngine | null {
  const pool = requireLocal ? engines.filter((e) => e.local) : engines;
  if (preferred && preferred.trim().length > 0) {
    const m = normalizePreference(preferred, pool);
    if (m) return m;
    return null;  // caller handles the unknown-service escape hatch (cloud-allowed mode only)
  }
  return pool[0] ?? null;
}

/**
 * Pick the best TTS engine to use given an optional user preference.
 *
 *   - If `preferred` is set AND matches an installed engine (via fuzzy
 *     normalization), use it.
 *   - Else return the highest-quality detected engine.
 *   - Else null (no TTS).
 *
 * v0.9.65 — `requireLocal` gates Cloud TTS hard.
 *   When true:
 *     - The candidate pool is filtered to engines where `local === true`
 *       BEFORE preference matching. Preference still wins inside that
 *       narrowed pool — so `BROADCAST_TTS_SERVICE=tts.piper` + REQUIRE_LOCAL=true
 *       still picks Piper, but `BROADCAST_TTS_SERVICE=tts.cloud_say` +
 *       REQUIRE_LOCAL=true returns null (caller must skip TTS, NOT fall
 *       back to anything cloud).
 *     - The "unknown service preference" escape hatch is also disabled
 *       — an unrecognized preference gets `local: false` by default and
 *       we will NOT assume it's local. If the user has a local engine we
 *       don't know about, they need to teach our KNOWN_ENGINES list.
 *     - Returns null when no local engine is detected — caller (broadcast
 *       orchestrator) is responsible for falling through to klaxon-only.
 *
 * The off-grid use case: the operator's home runs without internet for stretches.
 * Cloud TTS silently failing back to Nabu Casa during an alarm is exactly
 * the failure mode REQUIRE_LOCAL is built to prevent.
 */
export async function pickBestEngine(
  preferred: string | null,
  requireLocal = false,
): Promise<TtsEngine | null> {
  const all = await detectTtsEngines();
  const picked = pickEngineFromList(all, preferred, requireLocal);
  if (picked) return picked;
  // v0.9.65 — the unknown-service escape hatch only runs in cloud-allowed
  // mode. With REQUIRE_LOCAL on we can't verify the locality of an unknown
  // service, so we refuse rather than risk a Cloud fallback in disguise.
  if (preferred && preferred.trim().length > 0 && !requireLocal) {
    const [domain, service] = preferred.split('.');
    if (domain && service && await hasService(domain, service)) {
      return { service: preferred, label: preferred, local: false, quality: 3 };
    }
  }
  return null;
}

/* ─── message synthesis ──────────────────────────────────────────── */

/**
 * Turn an Alert into a clear, spoken sentence. Examples:
 *
 *   "Critical alarm. Critical alarm. Battery system, Core three pack two.
 *    Pack health critical. Pack S O H is sixty-eight point two percent, below
 *    seventy percent floor. Acknowledge at console. Repeat. Critical alarm.
 *    Critical alarm. Pack health critical."
 *
 *   "High priority alarm. Solar system, Core five. High voltage M P P T error
 *    code seventeen reported."
 *
 *   "All clear. All stations report normal."
 *
 * Designed to be unambiguous even when partially heard from another room.
 */
export function buildAlertMessage(level: 'red' | 'yellow' | 'green', alerts: Alert[]): string {
  if (level === 'green') {
    return 'All clear. All stations report normal.';
  }

  const isCritical = level === 'red';
  const primary = pickPrimaryAlert(alerts, level);
  if (!primary) {
    // v0.11.0 — no primary alert in hand; derive the spoken prefix from the
    // severity that this broadcast level represents (red→critical, yellow→
    // warning) so the fallback uses ISA priority vocabulary too.
    const fallbackPrefix = priorityAnnouncementPrefix(
      priorityOf({ severity: isCritical ? 'critical' : 'warning' }),
    );
    return isCritical
      ? `${fallbackPrefix} Critical condition detected. Check console for details.`
      : `${fallbackPrefix} Caution advised. Check console for details.`;
  }

  // v0.11.0 — ISA priority prefix derived from the primary alert (replaces the
  // old colour-named "Red alert / Yellow alert"). Critical yields a repeated
  // "Critical alarm. Critical alarm." from the helper.
  const prefix = priorityAnnouncementPrefix(priorityOf(primary));
  const cat = ttsifyCategory(primary.category);
  const loc = ttsifyLocation(primary.coreNum, primary.packNum);
  const title = ttsifyText(primary.title);
  const detail = ttsifyText(shortenDetail(primary.detail));

  const head = loc
    ? `${prefix} ${cat} ${loc}. ${title}.`
    : `${prefix} ${cat}. ${title}.`;
  const body = detail.length > 0 ? ` ${detail}` : '';
  const ack = isCritical ? ' Acknowledge at console.' : '';

  if (isCritical) {
    // Critical alerts get a repeat, briefly. Helps if the operator was
    // mid-conversation when the klaxon hit.
    return `${head}${body}${ack} Repeat. ${prefix} ${title}.`;
  }
  return `${head}${body}`;
}

/** Pick the most important alert to feature in the spoken message.
 *  Prefer critical over warning, then prefer ones with location, then
 *  by category importance (Battery > Solar > SHP2 > Grid > Thermal). */
function pickPrimaryAlert(alerts: Alert[], level: 'red' | 'yellow'): Alert | null {
  const targetSeverity = level === 'red' ? 'critical' : 'warning';
  // v0.16.4 — never feature a non-annunciating alert (annunciate === false, e.g.
  // an expected-offline bench spare) in the spoken message: it must not be heard
  // even when a genuine alert triggers the broadcast it would otherwise share.
  const candidates = alerts.filter((a) => a.severity === targetSeverity && a.annunciate !== false);
  if (candidates.length === 0) return null;
  const catRank: Record<string, number> = {
    Battery: 1, SHP2: 2, Solar: 3, Grid: 4, Thermal: 5, Connectivity: 6,
  };
  candidates.sort((a, b) => {
    const locA = (a.coreNum != null) ? 0 : 1;
    const locB = (b.coreNum != null) ? 0 : 1;
    if (locA !== locB) return locA - locB;
    const rankA = catRank[a.category] ?? 99;
    const rankB = catRank[b.category] ?? 99;
    return rankA - rankB;
  });
  return candidates[0];
}

/** "Battery" → "Battery system", etc. — makes the category land
 *  naturally as a clause in spoken English. */
function ttsifyCategory(cat: string): string {
  switch (cat) {
    case 'Battery':      return 'Battery system';
    case 'Solar':        return 'Solar system';
    case 'SHP2':         return 'Smart panel';
    case 'Grid':         return 'Grid status';
    case 'Thermal':      return 'Thermal management';
    case 'Connectivity': return 'Connectivity';
    default:             return cat;
  }
}

/** Render coreNum / packNum into a spoken location.
 *  "Core 3 Pack 2" → "Core three pack two". */
function ttsifyLocation(coreNum: number | null | undefined, packNum: number | null | undefined): string | null {
  if (coreNum == null) return null;
  const core = `Core ${numberWord(coreNum)}`;
  if (packNum == null) return core;
  return `${core} pack ${numberWord(packNum)}`;
}

/** Tiny number-to-word for digits 0-9 (covers our Core / pack range).
 *  Larger numbers stay numeric (TTS engines handle "23" fine). */
function numberWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  if (n >= 0 && n <= 9 && Number.isInteger(n)) return words[n];
  return String(n);
}

/** Normalize text for TTS — replace symbols and abbreviations that
 *  some engines read poorly ("%" as "percent sign"), but leave most
 *  alone so the alert author's wording survives.
 *
 *  Conservative: we only fix things we've actually seen go wrong. */
function ttsifyText(s: string): string {
  return s
    .replace(/%/g, ' percent')
    .replace(/°F/g, ' degrees Fahrenheit')
    .replace(/°C/g, ' degrees Celsius')
    .replace(/\bSoC\b/g, 'state of charge')
    .replace(/\bSoH\b/g, 'state of health')
    .replace(/\bIR\b/g, 'internal resistance')
    .replace(/\bMPPT\b/g, 'M P P T')
    .replace(/\bBMS\b/g, 'B M S')
    .replace(/\bEMS\b/g, 'E M S')
    .replace(/\bHV\b/g, 'high voltage')
    .replace(/\bLV\b/g, 'low voltage')
    .replace(/\bEV\b/g, 'E V')
    .replace(/\bSHP2\b/g, 'smart panel')
    .replace(/\bDPU\b/g, 'D P U')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Detail strings can run long. For TTS we keep it under ~200 chars
 *  to stay snappy — listeners tune out longer narrations. */
function shortenDetail(detail: string): string {
  if (detail.length <= 200) return detail;
  // Try to cut at a sentence boundary.
  const truncated = detail.slice(0, 200);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > 100) return truncated.slice(0, lastPeriod + 1);
  return truncated + '...';
}

/* ─── invocation ─────────────────────────────────────────────────── */

export interface TtsCallOptions {
  /** Targets — array of media_player entity_ids. */
  targets: string[];
  /** The chosen TTS engine. */
  engine: TtsEngine;
  /** Optional language code (engine-specific). */
  language?: string | null;
  /** When true, route through MA's announcement queue for better multi-speaker sync. */
  viaMusicAssistant?: boolean;
}

/**
 * Fire a TTS announcement.
 *
 * Three call paths are supported:
 *   1. Modern unified — service field is `tts.speak:<tts_entity>` →
 *      call `tts.speak` with `entity_id: <tts_entity>`,
 *      `media_player_entity_id: <targets>`. (HA 2023+ recommended path.)
 *   2. Legacy domain-specific — service field is e.g. `tts.cloud_say` →
 *      call it with `entity_id: <targets>`.
 *   3. MA-routed — if `viaMusicAssistant` is true AND the modern path
 *      is available, future enhancement could route via MA's TTS handler
 *      for tighter multi-speaker sync. Currently we still call the TTS
 *      service directly since MA's TTS pass-through is engine-dependent.
 *
 * Returns the underlying ServiceCallResult so the caller can attribute
 * errors per-call.
 */
export async function speakAnnouncement(message: string, opts: TtsCallOptions): Promise<ServiceCallResult> {
  const language = opts.language ?? null;
  const targets = opts.targets;
  const service = opts.engine.service;

  // Modern path: service ref is "tts.speak:<tts_entity>".
  if (service.startsWith('tts.speak:')) {
    const ttsEntityId = service.slice('tts.speak:'.length);
    const data: Record<string, unknown> = {
      entity_id: ttsEntityId,
      media_player_entity_id: targets,
      message,
      cache: true,
    };
    if (language) data.language = language;
    return callHaService('tts', 'speak', data);
  }

  // Legacy path: domain-specific service, takes media_player as entity_id.
  const [domain, svc] = service.split('.');
  const data: Record<string, unknown> = {
    entity_id: targets,
    message,
    cache: true,
  };
  if (language) data.language = language;

  void opts.viaMusicAssistant;  // reserved for future MA-TTS routing

  return callHaService(domain, svc, data);
}

/**
 * v0.9.40 — Speak via Music Assistant's `play_announcement`.
 *
 * The full pipeline:
 *   1. Render the TTS message to a URL via HA's `/api/tts_get_url`.
 *   2. Pass that URL to `music_assistant.play_announcement` — same path
 *      MA uses to play the klaxon, so MA "owns" all audio output and
 *      there's no contention with the speaker session.
 *
 * This is the workaround for the v0.9.39 failure where MA owned the
 * speakers and `tts.speak` couldn't acquire them after a klaxon.
 *
 * The `engine.service` field must be `tts.speak:<entity>` form (modern
 * path) — we need the entity ID to render via tts_get_url. Legacy
 * service-only engines (e.g. `tts.cloud_say`) can't go through this
 * path; the caller should fall back to `speakAnnouncement` for those.
 *
 * Returns the underlying ServiceCallResult from `music_assistant.play_announcement`
 * (the URL render + play step). If render fails, status=0 and error
 * describes "render failed".
 */
export async function speakViaMusicAssistant(
  message: string,
  opts: TtsCallOptions & { externalBaseUrl?: string | null; announceVolume?: number | null },
): Promise<ServiceCallResult & { ttsUrl?: string }> {
  const { engine, targets, language, externalBaseUrl, announceVolume } = opts;
  // Only the modern entity-based engines work — we need the entity ID
  // to render TTS without binding to a media_player.
  if (!engine.service.startsWith('tts.speak:')) {
    return {
      ok: false,
      status: 0,
      error: `speakViaMusicAssistant requires tts.speak:<entity> engine; got "${engine.service}"`,
    };
  }
  const ttsEntityId = engine.service.slice('tts.speak:'.length);
  const rendered = await ttsGetUrl(ttsEntityId, message, language ?? null, externalBaseUrl ?? null);
  // v0.9.49 — propagate the real diagnostic from haService instead of
  // collapsing to "returned null". Distinguishes "Piper unconfigured"
  // (HA 500 with "no voice") vs "engine_id not found" (HA 400) vs
  // "not supervised" (no token) — all of which used to look identical.
  if (rendered.error || !rendered.url) {
    return {
      ok: false,
      status: 0,
      error: rendered.error || `tts_get_url returned empty url for engine ${ttsEntityId}`,
    };
  }
  // Play the rendered URL via MA. use_pre_announce: false because TTS
  // doesn't need a chime — the message itself is the announcement.
  const data: Record<string, unknown> = {
    entity_id: targets,
    url: rendered.url,
    use_pre_announce: false,
  };
  if (announceVolume != null) data.announce_volume = announceVolume;
  const playRes = await callHaService('music_assistant', 'play_announcement', data);
  return { ...playRes, ttsUrl: rendered.url };
}

/**
 * v0.9.31 — Speak with fallback chain.
 *
 * Tries `engines` in order. Returns the first successful call's result,
 * or the LAST failure if all engines fail. Per-engine errors are
 * accumulated in the returned ServiceCallResult.error so the caller
 * can log the full picture.
 *
 * This is the function the broadcast monitor should call: if the
 * preferred engine is having a bad day (the v0.9.30 yellow-test 500
 * from tts.cloud_say is the canonical example), we try the next-best
 * engine instead of losing the spoken announcement entirely.
 */
export async function speakWithFallback(
  message: string,
  engines: TtsEngine[],
  opts: Omit<TtsCallOptions, 'engine'>,
): Promise<{ result: ServiceCallResult; engineUsed: TtsEngine | null; attempts: Array<{ engine: TtsEngine; error: string | null }> }> {
  const attempts: Array<{ engine: TtsEngine; error: string | null }> = [];
  let lastResult: ServiceCallResult = { ok: false, status: 0, error: 'no engines tried' };
  for (const eng of engines) {
    // v0.9.38 — single-attempt with 1.5-sec retry on 500. Production testing
    // showed that TTS service calls right after MA klaxon announcements can
    // return 500 even when the engine works standalone (MA's restore phase
    // collides with new TTS commands). One quick retry usually catches the
    // narrow window where MA hasn't fully released the speakers yet.
    let r = await speakAnnouncement(message, { ...opts, engine: eng });
    if (!r.ok && r.status === 500) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      r = await speakAnnouncement(message, { ...opts, engine: eng });
    }
    if (r.ok) {
      attempts.push({ engine: eng, error: null });
      return { result: r, engineUsed: eng, attempts };
    }
    attempts.push({ engine: eng, error: r.error ?? `HTTP ${r.status}` });
    lastResult = r;
  }
  return { result: lastResult, engineUsed: null, attempts };
}
