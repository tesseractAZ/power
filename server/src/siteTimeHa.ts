/**
 * siteTimeHa.ts — the main thread's side of the site clock (plan 2.4, CA17): the boot log line, the
 * best-effort comparison with Home Assistant's own time zone, and the repair issues for both.
 *
 * The site zone is resolved once, synchronously, when siteTime.ts loads (SITE_TIMEZONE → TZ → the
 * default). Nothing here changes it: Home Assistant's `/core/api/config` `time_zone` is read in the
 * background after boot, and a difference raises a warning and a repair issue — the add-on keeps the
 * zone it booted with until it is restarted. Resolving the zone from an HTTP answer instead would let
 * a slow or failed request decide every local date computed before it returned (the readiness race).
 *
 * Only the main thread imports this module; the analytics worker resolves the same zone from the
 * same environment through siteTime.ts and logs nothing.
 */
import { request } from 'undici';
import { option } from './config.js';
import type { RepairIssue } from './repairIssues.js';
import { checkTimeZone, siteTimeZoneResolution, siteTimeZoneLogLine, type SiteTimeZoneResolution } from './siteTime.js';

export interface HaZoneCheck {
  /** Home Assistant's `time_zone`, or null when the read failed or the field was absent. */
  haZone: string | null;
  /** The site zone it was compared with. */
  siteZone: string;
  mismatch: boolean;
  checkedAtMs: number;
}

const BOOT_AT_MS = Date.now();
let lastCheck: HaZoneCheck | null = null;

/** Does Home Assistant's zone differ from the site zone? A link of the same zone is the same zone. PURE. */
export function haZoneDiffers(siteZone: string, haZone: string | null | undefined): boolean {
  if (haZone == null || haZone.trim() === '') return false;
  const r = checkTimeZone(haZone);
  return ('zone' in r ? r.zone : haZone.trim()) !== siteZone;
}

/** GET http://supervisor/core/api/config → its `time_zone`, or null. Never throws. */
export async function fetchHaTimeZone(timeoutMs = 10_000): Promise<string | null> {
  const token = option<string | undefined>('SUPERVISOR_TOKEN');
  if (!token) return null;
  try {
    const res = await request('http://supervisor/core/api/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const tz = (JSON.parse(text) as { time_zone?: unknown })?.time_zone;
    return typeof tz === 'string' && tz.trim() !== '' ? tz.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Compare Home Assistant's zone with the site zone, once, in the background. Logs a warning on a
 * difference; silent when they agree or when Home Assistant cannot be read (outside the add-on, or a
 * transient failure). Never switches the zone. Never throws.
 */
export async function checkHaTimeZone(
  warn: (msg: string) => void,
  fetchZone: () => Promise<string | null> = fetchHaTimeZone,
  resolution: SiteTimeZoneResolution = siteTimeZoneResolution(),
  nowMs: () => number = Date.now,
): Promise<HaZoneCheck | null> {
  let haZone: string | null = null;
  try { haZone = await fetchZone(); } catch { haZone = null; }
  if (haZone == null) return null;
  const mismatch = haZoneDiffers(resolution.zone, haZone);
  const check: HaZoneCheck = { haZone, siteZone: resolution.zone, mismatch, checkedAtMs: nowMs() };
  lastCheck = check;
  if (mismatch) {
    warn(`site time zone ${resolution.zone} (source: ${resolution.source}) differs from Home Assistant's ${haZone}; `
      + 'the add-on keeps its zone until restarted — set SITE_TIMEZONE, or leave it empty to follow the container zone');
  }
  return check;
}

/** The boot log lines (main thread only): the resolved zone, then one warning per value that did not resolve. */
export function siteTimeBootLines(resolution: SiteTimeZoneResolution = siteTimeZoneResolution()): { info: string; warnings: string[] } {
  return {
    info: siteTimeZoneLogLine(resolution),
    warnings: resolution.rejected.map((r) => `${r.source}=${JSON.stringify(r.value)} is not a usable time zone (${r.reason}); using ${resolution.zone} (source: ${resolution.source})`),
  };
}

/** For tests: forget the last Home Assistant comparison. */
export function resetHaZoneCheckForTesting(): void { lastCheck = null; }

/**
 * The site-clock repair issues (shown with the others on GET /api/repair-issues): one per configured
 * zone that did not resolve, and one when Home Assistant's zone differs from the site zone.
 */
export function siteTimeRepairIssues(
  resolution: SiteTimeZoneResolution = siteTimeZoneResolution(),
  check: HaZoneCheck | null = lastCheck,
): RepairIssue[] {
  const out: RepairIssue[] = [];
  for (const r of resolution.rejected) {
    out.push({
      id: `site-timezone-invalid-${r.source}`,
      severity: 'warning',
      category: 'Configuration',
      title: `${r.source} is not a usable time zone`,
      summary: `${r.source} is set to ${JSON.stringify(r.value)}, which ${r.reason}. The add-on uses ${resolution.zone} (source: ${resolution.source}) for every local date, hour and clock time instead.`,
      fixSteps: r.source === 'SITE_TIMEZONE'
        ? [
          'Open the add-on Configuration and correct Site Time Zone to an IANA zone name such as Europe/Berlin, or clear it to follow Home Assistant\'s zone.',
          'Restart the add-on; the zone is read once at start.',
        ]
        : [
          'The container zone comes from Home Assistant: check Settings → System → General → Time zone.',
          'Or set the add-on\'s Site Time Zone option to an IANA zone name, then restart the add-on.',
        ],
      estimatedTimeMinutes: 2,
      firstSeenAt: BOOT_AT_MS,
    });
  }
  if (check?.mismatch) {
    out.push({
      id: 'site-timezone-differs-from-ha',
      severity: 'warning',
      category: 'Configuration',
      title: `The add-on's time zone (${check.siteZone}) differs from Home Assistant's (${check.haZone})`,
      summary: `Tariff periods, the night-charge window, quiet hours and daily totals are computed in ${check.siteZone}, while Home Assistant shows times in ${check.haZone}.`,
      fixSteps: [
        'If Home Assistant\'s zone is the right one, clear the add-on\'s Site Time Zone option and restart the add-on.',
        'If the add-on\'s zone is deliberate, no action is needed; the difference is reported so it is not a surprise.',
      ],
      estimatedTimeMinutes: 2,
      firstSeenAt: check.checkedAtMs,
    });
  }
  return out;
}
