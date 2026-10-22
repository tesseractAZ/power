import type { Site } from './types';

/**
 * v1.191.0 (lane C) — the site facts the cards read from GET /api/site (useSite.ts), as pure
 * helpers so the server test suite can run them. Every helper takes `site` as possibly null (not yet
 * loaded, or an older server) and then answers exactly as the card did before v1.191.0:
 *
 *   - PV strings: 10 HV + 4 LV panels of 400 W on every panel-bound Core (PV_STRINGS, CA23).
 *   - Spares (plan 3.8 S3): a DPU that is not a panel source is a spare with no array, until the
 *     server sends a per-DPU `benchSpare` flag, which it does only while BENCH_SPARE_SNS is set. Then
 *     a flagged unit is a spare and an unflagged one is "not on a panel" and keeps its array.
 *   - Solar assumptions (CA24): the orientation bands and the daylight band are today's while the PV
 *     site is the legacy site; otherwise they follow the site's solar noon and hemisphere.
 */

export type PvStrings = Site['pvStrings'];

/** Today's layout, the one every Core takes while /api/site has not answered. */
export const DEFAULT_PV_STRINGS: PvStrings = { hv: { count: 10, watts: 400 }, lv: { count: 4, watts: 400 } };

/** One DPU's strings: its own (an override for its name or slot), else the site layout, else today's. */
export function stringsFor(site: Site | null | undefined, sn: string): PvStrings {
  return site?.pvStringsPerDpu?.[sn] ?? site?.pvStrings ?? DEFAULT_PV_STRINGS;
}

export const panelsOf = (s: PvStrings): number => s.hv.count + s.lv.count;
export const stringsW = (s: PvStrings): number => s.hv.count * s.hv.watts + s.lv.count * s.lv.watts;

/**
 * The server's bench-spare verdict for a DPU, or undefined when it sent none (BENCH_SPARE_SNS unset,
 * or no /api/site yet): undefined means "use today's rule".
 */
export function benchSpareFlag(site: Site | null | undefined, sn: string): boolean | undefined {
  const v = site?.perDpu?.[sn]?.benchSpare;
  return typeof v === 'boolean' ? v : undefined;
}

/** A DPU that is not a panel source but the server says is not a spare: "not on a panel", array kept. */
export const offPanelNotSpare = (site: Site | null | undefined, sn: string): boolean => benchSpareFlag(site, sn) === false;

/**
 * The Solar page's array caption for the Cores it counts, e.g. "42 panels · 400 W each · 10 HV + 4 LV
 * per DPU" — today's text, word for word, while every Core has one layout of one panel wattage; a
 * plant whose Cores differ reads "N panels · X.X kWp · strings differ per DPU".
 */
export function arrayCaption(layouts: PvStrings[]): string {
  const total = layouts.reduce((s, l) => s + panelsOf(l), 0);
  const first = layouts[0] ?? DEFAULT_PV_STRINGS;
  const same = layouts.every((l) => l.hv.count === first.hv.count && l.lv.count === first.lv.count
    && l.hv.watts === first.hv.watts && l.lv.watts === first.lv.watts);
  const oneWattage = first.hv.count === 0 || first.lv.count === 0 || first.hv.watts === first.lv.watts;
  if (same && oneWattage) {
    const w = first.hv.count > 0 ? first.hv.watts : first.lv.watts;
    return `${total} panels · ${w} W each · ${first.hv.count} HV + ${first.lv.count} LV per DPU`;
  }
  const kwp = layouts.reduce((s, l) => s + stringsW(l), 0) / 1000;
  return `${total} panels · ${kwp.toFixed(1)} kWp · strings differ per DPU`;
}

/** The flow diagram's caption: today's "N panels · 400 W each" (or "N installed · M shown · …"). */
export function flowCaption(installed: PvStrings[], shown: PvStrings[]): string {
  const total = installed.reduce((s, l) => s + panelsOf(l), 0);
  const shownPanels = shown.reduce((s, l) => s + panelsOf(l), 0);
  const watts = new Set(installed.flatMap((l) => [l.hv.count > 0 ? l.hv.watts : null, l.lv.count > 0 ? l.lv.watts : null]).filter((w): w is number => w != null));
  const each = watts.size <= 1
    ? `${[...watts][0] ?? DEFAULT_PV_STRINGS.hv.watts} W each`
    : `${(installed.reduce((s, l) => s + stringsW(l), 0) / 1000).toFixed(1)} kWp`;
  return shownPanels < total ? `${total} installed · ${shownPanels} shown · ${each}` : `${total} panels · ${each}`;
}

/** Plain-language array orientation implied by the peak-production hour (ForecastDetail). */
export function orientationText(hour: number, solar: Site['solar'] | null | undefined): string {
  // Today's bands (clock noon, northern hemisphere) while the site is the legacy site or unknown.
  const legacy = !solar || solar.legacy;
  const h = legacy ? hour : hour - (solar.solarNoonHour - 12);
  const equator = !legacy && solar.hemisphere === 'south' ? 'north' : 'south';
  if (h <= 8) return 'strongly morning-biased — east-facing, or shaded later in the day';
  if (h <= 10) return `morning-biased — array faces east of ${equator}`;
  if (h <= 13) return `near solar noon — array faces close to true ${equator}`;
  if (h <= 15) return `afternoon-biased — array faces west of ${equator}`;
  return 'strongly afternoon-biased — west-facing, or shaded in the morning';
}

/** The hours the learned-response chart spans: today's 4..21 on the legacy site, the site's daylight otherwise. */
export function daylightBand(site: Site | null | undefined): [number, number] {
  const s = site?.solar;
  if (!s || s.legacy) return [4, 21];
  const [a, b] = s.daylightHours;
  return [Math.max(0, Math.min(23, Math.floor(a))), Math.max(0, Math.min(23, Math.floor(b)))];
}

/** ForecastDetail's line for a DPU with no recorded PV: today's text unless the server says what the unit is. */
export function noPvDetail(flag: boolean | undefined): string {
  if (flag === true) return "No recorded PV — a bench spare with no array; orientation can't be inferred.";
  if (flag === false) return "No recorded PV — offline gaps, or a Core with no array wired; orientation can't be inferred yet.";
  return "No recorded PV — offline gaps or an unwired spare; orientation can't be inferred yet.";
}

/** `zone`'s UTC offset in minutes at `ms` (en-US formatToParts), or null when the zone cannot be resolved. */
function zoneOffsetMin(ms: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const v = (k: string) => Number(parts.find((x) => x.type === k)?.value);
    const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'));
    const off = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
    return Number.isFinite(off) ? off : null;
  } catch {
    return null;
  }
}

/**
 * The start of the day holding `nowMs` in the site's zone (CA25: the Solar page's "today" query).
 * No zone (the site has not answered), or one the browser cannot resolve: the browser's own midnight,
 * as before v1.191.0.
 */
export function zoneDayStartMs(nowMs: number, zone: string | null | undefined): number {
  const browser = (): number => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); };
  if (!zone) return browser();
  const off = zoneOffsetMin(nowMs, zone);
  if (off == null) return browser();
  const local = new Date(nowMs + off * 60_000);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const guess = midnightAsUtc - off * 60_000;
  const offAtGuess = zoneOffsetMin(guess, zone);
  return offAtGuess == null || offAtGuess === off ? guess : midnightAsUtc - offAtGuess * 60_000;
}
