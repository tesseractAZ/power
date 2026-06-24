/**
 * Alert → spoken-message synthesis for ship-wide broadcasts.
 *
 * Turns an Alert into a clear, hearable announcement: severity prefix,
 * category, device location, then the human-readable detail — with symbols
 * and abbreviations normalized so TTS engines read them naturally
 * ("5%" → "five percent", "MPPT" → "M P P T").
 *
 * History: this module once also auto-detected HA's TTS engines, picked the
 * best one, and fired `tts.speak` / Music Assistant directly. The v0.9.70
 * "Wyoming-direct" broadcast rewrite (broadcast.ts → audioRenderer.ts) renders
 * alert audio through Wyoming and plays a single `music_assistant.play_announcement`,
 * bypassing HA's TTS service catalog entirely — which orphaned the detection /
 * selection / invocation halves (detectTtsEngines, pickBestEngine,
 * speakViaMusicAssistant, getTtsDebug, …). Those were removed in v0.24.4 as
 * dead code. The only remaining consumer of this module is `buildAlertMessage`
 * (broadcast.ts); it is the spoken-text formatter and is unchanged.
 */

import type { Alert } from './alerts.js';
import { priorityOf, priorityAnnouncementPrefix } from './alertPriority.js';

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
  const title = verbalizeForTts(primary.title);
  const detail = verbalizeForTts(shortenDetail(primary.detail));

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

/**
 * Verbalize a string for TTS so Piper/Wyoming reads it naturally instead of
 * letter-by-letter or symbol-literal. Supersedes the old narrow `ttsifyText`:
 * it now also expands UNITS ("6 h" → "6 hours", "450 W" → "450 watts",
 * "7.5 kWh" → "7.5 kilowatt hours"), relational/math symbols (≥ ≤ < > ~ ≈ — · → ²),
 * rate slashes ("%/h" → "percent per hour"), and plural "(s)" forms, on top of
 * the existing percent / temperature / domain-abbreviation handling.
 *
 * INVARIANTS:
 *  • IDEMPOTENT at the FUNCTION level — verbalizeForTts(verbalizeForTts(x)) ===
 *    verbalizeForTts(x) — because buildAlertMessage normalizes the alert
 *    title/detail and THEN the renderer (audioRenderer.renderAnnouncement)
 *    normalizes the whole assembled message a second time so the hand-built
 *    SoC/runway/test/preview strings get the same safety net. (Note: individual
 *    rules are not all self-no-ops — e.g. the h-rule turns "1 hour" into
 *    "1 hours" — but the trailing singularize rule repairs the one-plural, so the
 *    function as a whole round-trips. Any new time-unit rule must keep that
 *    singularize list in sync.)
 *  • Unit-expansion rules are NUMBER-ANCHORED ((\d…)\s*UNIT\b) so prose
 *    ("a breaker"), device SNs (GBC0314), and error codes are never corrupted by
 *    a unit rule — only a unit token abutting a number is expanded. Longest token
 *    first (kWh before Wh before W; rate slashes before the bare-% rule). The
 *    relational-symbol rules (< > ≥ ≤ ~ ≈) are intentionally un-anchored and fire
 *    on any occurrence; alert strings should use the Unicode ≥/≤ for comparisons
 *    (the ASCII >=/<= forms are handled too, but ≥/≤ is the house style).
 *  • Only the SPOKEN path calls this; on-screen / notification copy keeps its
 *    symbols. en_US only (the deployment's Piper voice). */
export function verbalizeForTts(s: string): string {
  return s
    // plural "(s)" → plain plural BEFORE parens are stripped: "month(s)" → "months"
    .replace(/\b(hour|minute|second|day|week|month|year|pack|cell|core|unit|panel)\(s\)/gi, '$1s')
    // rate slashes → "per <unit>" (BEFORE the bare-% / unit rules consume the head)
    .replace(/\/\s*h\b/g, ' per hour')                       // %/h, kWh/h
    .replace(/\/\s*(day|week|month|year)\b/g, ' per $1')      // kWh/day, mV/week, %/month
    // relational / approximation / math symbols
    .replace(/\s*≥\s*/g, ' at or above ')
    .replace(/\s*≤\s*/g, ' at or below ')
    .replace(/\s*>=\s*/g, ' at or above ')  // ASCII forms before the bare < > rules, so no dangling "="
    .replace(/\s*<=\s*/g, ' at or below ')
    .replace(/\s*[≈~]\s*/g, ' about ')
    .replace(/\s*<\s*/g, ' below ')
    .replace(/\s*>\s*/g, ' above ')
    .replace(/\s*→\s*/g, ' to ')
    .replace(/²/g, ' squared')
    // separators → a spoken pause
    .replace(/\s*[—–]\s*/g, ', ')                             // em / en dash
    .replace(/\s*·\s*/g, ', ')                                // middot
    .replace(/[()]/g, ' ')                                    // drop parens (plural "(s)" already handled)
    // duration combo BEFORE the generic hour rule: "3h 7m" → "3 hours 7 minutes"
    .replace(/(\d+)\s*h\s+(\d+)\s*m\b/g, '$1 hours $2 minutes')
    // energy / power / electrical units — number-anchored, longest token first
    .replace(/(\d+(?:\.\d+)?)\s*kWh\b/g, '$1 kilowatt hours')
    .replace(/(\d+(?:\.\d+)?)\s*Wh\b/g, '$1 watt hours')
    .replace(/(\d+(?:\.\d+)?)\s*kWp\b/g, '$1 kilowatts peak')
    .replace(/(\d+(?:\.\d+)?)\s*kW\b/g, '$1 kilowatts')
    .replace(/(\d+(?:\.\d+)?)\s*W\b/g, '$1 watts')
    .replace(/(\d+(?:\.\d+)?)\s*mAh\b/g, '$1 milliamp hours')
    .replace(/(\d+(?:\.\d+)?)\s*Ah\b/g, '$1 amp hours')
    .replace(/(\d+(?:\.\d+)?)\s*mA\b/g, '$1 milliamps')
    .replace(/(\d+(?:\.\d+)?)\s*A\b/g, '$1 amps')
    .replace(/(\d+(?:\.\d+)?)\s*mV\b/g, '$1 millivolts')
    .replace(/(\d+(?:\.\d+)?)\s*kV\b/g, '$1 kilovolts')
    .replace(/(\d+(?:\.\d+)?)\s*V\b/g, '$1 volts')
    // time units — number-anchored
    .replace(/(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?\b/g, '$1 hours') // 6h, 6 h, 6hr, 6 hrs, 6 hours
    .replace(/(\d+(?:\.\d+)?)\s*min(?:ute)?s?\b/g, '$1 minutes')
    .replace(/(\d+(?:\.\d+)?)\s*mo\b/g, '$1 months')
    // temperature & percent
    .replace(/°F/g, ' degrees Fahrenheit')
    .replace(/°C/g, ' degrees Celsius')
    .replace(/%/g, ' percent')
    // domain abbreviations — expand unknowns to words; keep established initialisms
    .replace(/\bSoC\b/g, 'state of charge')
    .replace(/\bSoH\b/g, 'state of health')
    .replace(/\bIR\b/g, 'internal resistance')
    .replace(/\bEVSE\b/g, 'charger')          // before EV
    .replace(/\bRTE\b/g, 'round trip efficiency')
    .replace(/\bTOU\b/g, 'time of use')
    .replace(/\bPV\b/g, 'solar')
    .replace(/\bMPPT\b/g, 'M P P T')
    .replace(/\bBMS\b/g, 'B M S')
    .replace(/\bEMS\b/g, 'E M S')
    .replace(/\bHV\b/g, 'high voltage')
    .replace(/\bLV\b/g, 'low voltage')
    .replace(/\bEV\b/g, 'E V')
    .replace(/\bSHP2\b/g, 'smart panel')
    .replace(/\bDPU\b/g, 'D P U')
    // singularize the realistic "1 <time>s" cases ("reserve in 1 hours" → "1 hour")
    .replace(/\b1 (hour|minute|month|day|week|year)s\b/g, '1 $1')
    // tidy: no space before punctuation introduced above, then collapse runs
    .replace(/\s+([,.;:!?])/g, '$1')
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

/* ─── v0.62.0 — Spanish (Latin American) second pass ─────────────────────────
 *
 * A bilingual broadcast plays the message in English, then in Spanish. The
 * Spanish wording is built from STATIC templates (offline, deterministic, safe
 * for a critical alarm — no translation API on the alarm path). `buildAlertMessageEs`
 * mirrors `buildAlertMessage`: the severity prefix, category, location, the
 * acknowledge/repeat scaffolding, the all-clear and the no-primary fallbacks are
 * fully Spanish, and the alert TITLE is translated for the broadcast-eligible
 * families via an id-prefix map. The free-form DETAIL tail falls back to the
 * (English) original — by design — rather than risk a mistranslated specific.
 * The hand-built SoC / runway alarms have their own Spanish builders
 * (batterySocAlarm.socAlarmMessageEs, runwayAlarm.runwayAlarmMessageEs). */

/**
 * Light Spanish normalizer for the TTS chokepoint (the `es` counterpart of
 * `verbalizeForTts`). The Spanish templates are authored already spoken-ready
 * (units spelled out: "por ciento", "horas", "voltios"), so this only converts
 * stray symbols a template might still carry — and the English detail-fallback
 * has already been run through the English verbalizer, so its "%"/units are gone
 * before they reach here. IDEMPOTENT.
 */
export function verbalizeForTtsEs(s: string): string {
  return s
    .replace(/\s*≥\s*/g, ' mayor o igual a ')
    .replace(/\s*≤\s*/g, ' menor o igual a ')
    .replace(/\s*>=\s*/g, ' mayor o igual a ')
    .replace(/\s*<=\s*/g, ' menor o igual a ')
    .replace(/\s*[≈~]\s*/g, ' aproximadamente ')
    .replace(/\s*<\s*/g, ' menor que ')
    .replace(/\s*>\s*/g, ' mayor que ')
    .replace(/\s*→\s*/g, ' a ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*·\s*/g, ', ')
    .replace(/²/g, ' al cuadrado')
    .replace(/°F/g, ' grados Fahrenheit')
    .replace(/°C/g, ' grados centígrados')
    .replace(/%/g, ' por ciento')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Spanish ISA priority prefix (mirror of priorityAnnouncementPrefix). Critical
 *  doubles for emphasis, like the English. */
export function priorityAnnouncementPrefixEs(priority: 'critical' | 'high' | 'medium' | 'low'): string {
  switch (priority) {
    case 'critical': return 'Alarma crítica. Alarma crítica.';
    case 'high':     return 'Alarma de alta prioridad.';
    case 'medium':   return 'Alarma de prioridad media.';
    case 'low':      return 'Aviso de baja prioridad.';
  }
}

/** Spanish category clause (mirror of ttsifyCategory). */
function categoryEs(cat: string): string {
  switch (cat) {
    case 'Battery':      return 'Sistema de baterías';
    case 'Solar':        return 'Sistema solar';
    case 'SHP2':         return 'Panel inteligente';
    case 'Grid':         return 'Estado de la red';
    case 'Thermal':      return 'Gestión térmica';
    case 'Connectivity': return 'Conectividad';
    default:             return cat;
  }
}

/** Spanish spoken location. "Core" is kept as the product label (the operator
 *  names the units Core 1–5 in both languages); the pack reads as "batería". */
function locationEs(coreNum: number | null | undefined, packNum: number | null | undefined): string | null {
  if (coreNum == null) return null;
  const core = `Core ${numberWordEs(coreNum)}`;
  if (packNum == null) return core;
  return `${core} batería ${numberWordEs(packNum)}`;
}

/** Spanish number-to-word for 0–9 (Core / pack range); larger stays numeric. */
function numberWordEs(n: number): string {
  const words = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  if (n >= 0 && n <= 9 && Number.isInteger(n)) return words[n];
  return String(n);
}

/** Spanish TITLE for the broadcast-eligible alert families, keyed by the stable
 *  `id` slug prefix (the part before the interpolated SN/pack/slot). Returns null
 *  for families with a dynamic title (e.g. per-component thermal) → the caller
 *  falls back to the English title. Ordered so longer prefixes match first
 *  (dpu-pvh-err / dpu-pvl-err before dpu-err). */
const ES_TITLE_BY_ID_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['soh-crit', 'Salud de batería crítica'],
  ['soh-warn', 'Salud de batería degradada'],
  ['vdiff-crit', 'Desequilibrio de celdas'],
  ['vdiff-warn', 'Desequilibrio de celdas'],
  ['soc-low', 'Batería casi vacía'],
  ['ems-volt', 'Voltaje de batería fuera del rango permitido'],
  ['dpu-imbalance', 'Baterías desequilibradas'],
  ['dpu-pvh-err', 'Código de error del MPPT de alto voltaje'],
  ['dpu-pvl-err', 'Código de error del MPPT de bajo voltaje'],
  ['dpu-err', 'Código de error del inversor'],
  ['shp2-src-err', 'Error en una fuente de energía'],
  ['shp2-src-hw', 'Problema de enlace en una fuente'],
  ['shp2-below-reserve', 'Respaldo por debajo de la reserva'],
  ['shp2-near-reserve', 'Respaldo acercándose a la reserva'],
  ['circuit-overload', 'Circuito cerca del límite del disyuntor'],
  ['cloud-session-stale', 'Sesión de la nube de EcoFlow inactiva'],
  ['offline', 'Dispositivo desconectado'],
  ['stale', 'Telemetría sin actualizar'],
];

function esTitleFor(id: string): string | null {
  for (const [prefix, es] of ES_TITLE_BY_ID_PREFIX) {
    if (id === prefix || id.startsWith(prefix + '-')) return es;
  }
  return null;
}

/**
 * Spanish (Latin American) mirror of buildAlertMessage — the SECOND broadcast
 * pass. Same primary-alert selection as the English pass (reuses pickPrimaryAlert)
 * so both passes describe the same condition. Framing is fully Spanish; the title
 * is translated when the family is known (esTitleFor), else the English title is
 * read; the detail tail is the English original (verbalized) by design.
 */
export function buildAlertMessageEs(level: 'red' | 'yellow' | 'green', alerts: Alert[]): string {
  if (level === 'green') {
    return 'Todo despejado. Todas las estaciones reportan normalidad.';
  }

  const isCritical = level === 'red';
  const primary = pickPrimaryAlert(alerts, level);
  if (!primary) {
    const fallbackPrefix = priorityAnnouncementPrefixEs(
      priorityOf({ severity: isCritical ? 'critical' : 'warning' }),
    );
    return isCritical
      ? `${fallbackPrefix} Condición crítica detectada. Consulte la consola para más detalles.`
      : `${fallbackPrefix} Se recomienda precaución. Consulte la consola para más detalles.`;
  }

  const prefix = priorityAnnouncementPrefixEs(priorityOf(primary));
  const cat = categoryEs(primary.category);
  const loc = locationEs(primary.coreNum, primary.packNum);
  // Spanish title when the family is known; otherwise the English title (verbalized).
  const title = esTitleFor(primary.id) ?? verbalizeForTts(primary.title);
  // Detail tail falls back to the English original (verbalized) — by design.
  const detail = verbalizeForTts(shortenDetail(primary.detail));

  const head = loc
    ? `${prefix} ${cat} ${loc}. ${title}.`
    : `${prefix} ${cat}. ${title}.`;
  const body = detail.length > 0 ? ` ${detail}` : '';
  const ack = isCritical ? ' Confirme en la consola.' : '';

  if (isCritical) {
    return `${head}${body}${ack} Repito. ${prefix} ${title}.`;
  }
  return `${head}${body}`;
}
