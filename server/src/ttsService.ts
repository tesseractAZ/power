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
