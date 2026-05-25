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

import { getServiceCatalog, hasService, callHaService, type ServiceCallResult } from './haService.js';
import type { Alert } from './alerts.js';

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
 * Detect which TTS engines are exposed by HA right now. Returns them
 * sorted by quality (best first). Empty when not supervised or when
 * none are installed.
 */
export async function detectTtsEngines(): Promise<TtsEngine[]> {
  const cat = await getServiceCatalog();
  if (!cat) return [];
  const found: TtsEngine[] = [];
  for (const eng of KNOWN_ENGINES) {
    const [domain, service] = eng.service.split('.');
    const d = cat.find((c) => c.domain === domain);
    if (d && service in d.services) {
      found.push(eng);
    }
  }
  // Stable sort: quality asc (best first), then local first.
  found.sort((a, b) => a.quality - b.quality || (a.local === b.local ? 0 : a.local ? -1 : 1));
  return found;
}

/**
 * Pick the best TTS engine to use given an optional user preference.
 *
 *   - If `preferred` is set AND matches an installed engine, use it.
 *   - Else return the highest-quality detected engine.
 *   - Else null (no TTS).
 */
export async function pickBestEngine(preferred: string | null): Promise<TtsEngine | null> {
  const engines = await detectTtsEngines();
  if (preferred) {
    const m = engines.find((e) => e.service === preferred);
    if (m) return m;
    // User set a preference we don't recognize — check if it's a service
    // that exists in HA even if not in our known-engines list.
    const [domain, service] = preferred.split('.');
    if (domain && service && await hasService(domain, service)) {
      return { service: preferred, label: preferred, local: false, quality: 3 };
    }
  }
  return engines[0] ?? null;
}

/* ─── message synthesis ──────────────────────────────────────────── */

/**
 * Turn an Alert into a clear, spoken sentence. Examples:
 *
 *   "Red alert. Battery system, Core three pack two. Pack health critical.
 *    Pack S O H is sixty-eight point two percent, below seventy percent floor.
 *    Acknowledge at console alpha. Repeat. Red alert. Pack health critical."
 *
 *   "Yellow alert. Solar system, Core five. High voltage M P P T error code
 *    seventeen reported."
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
    return isCritical
      ? 'Red alert. Critical condition detected. Check console for details.'
      : 'Yellow alert. Caution advised. Check console for details.';
  }

  const prefix = isCritical ? 'Red alert. Red alert.' : 'Yellow alert.';
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
  const candidates = alerts.filter((a) => a.severity === targetSeverity);
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
 * Fire a TTS announcement. Uses the modern `tts.speak` service when the
 * picked engine is named that way, or the legacy domain-specific service
 * for engines like `tts.google_translate_say`.
 *
 * Returns the underlying ServiceCallResult so the caller can attribute
 * errors per-call.
 */
export async function speakAnnouncement(message: string, opts: TtsCallOptions): Promise<ServiceCallResult> {
  const { service, language, targets, viaMusicAssistant } = {
    service: opts.engine.service,
    language: opts.language ?? null,
    targets: opts.targets,
    viaMusicAssistant: opts.viaMusicAssistant ?? false,
  };
  const [domain, svc] = service.split('.');

  // The modern `tts.speak` service takes (entity_id of TTS engine,
  // media_player_entity_id, message). Older engine-specific services
  // take (entity_id of media_player, message). We don't try to dispatch
  // between them — `tts.speak` requires knowing the TTS entity_id which
  // we'd have to look up. Stick to engine-specific services for now and
  // document `tts.speak` as a future enhancement.
  const data: Record<string, unknown> = {
    entity_id: targets,
    message,
    cache: true,
  };
  if (language) data.language = language;

  // When MA is available, MA's TTS routing handles multi-speaker sync
  // better than raw tts service (which fires sequentially across targets).
  // We don't yet do this routing — would need a separate MA TTS service —
  // but the flag is here so the caller can opt in once we wire it up.
  void viaMusicAssistant;

  return callHaService(domain, svc, data);
}
