#!/usr/bin/env node
/**
 * mutate-v1191-1.mjs — v1.191.1: the console's and the web's last host- and browser-clock labels, and
 * the per-Core shade fixture the release rewrote.
 *
 *   V1-i     the ALARM LIST divider is back on the host clock (toTimeString)
 *   V1-ii    the MAIN BUS divider is back on the host clock (toTimeString)
 *   V1-iii   fmtLocaleIn drops the zone (every label it writes is the browser's clock)
 *   V1-iv    the Today card writes "since" in the browser zone again
 *   V1-v     /api/summary/today stops stamping the site zone
 *   V1-vi    zonedHourIn reads the browser's getHours
 *   V1-vii   the forecast hour rows are labelled from the browser's getHours again
 *   V1-viii  the Solar page takes the browser's zone instead of the payload's
 *   V1-ix    /api/forecast stops stamping the site zone
 *   V1-x     the dashboard forecast axis is in the browser zone again
 *   V1-xi    the dashboard forecast's projected-low time is in the browser zone again
 *   V1-xii   the Solar page's hour rows are not handed the zone (every row reads "—")
 *   V1-xiii  the Today card's header drops the "since" time
 *   V1-xiv   the dashboard forecast's projected-low tile drops its time
 *   V1-xv    the CONSOLE alarm banner formats its time on the host clock, with a locale and options
 *   V1-xvi   the CONSOLE status header formats its stamp on the host clock, with a locale and options
 *   V1-xvii  the alarm rows format their onset on the host clock, in the same YYYY-MM-DD HH:MM:SS form
 *   V1-xviii the shade report sums the home Cores into one fleet series again (the pre-v0.93.0 path)
 *   V1-xix   the shade report's clean reference is the median, not the 90th percentile
 *   V1-xx    the shade report's reference keeps a Core's zero (gap) hours
 *
 * The console cases run the screens in child processes with a New York site on a Phoenix host and a
 * Phoenix site on a UTC host, so every mutant dies whatever the runner's own zone. V1-xv to V1-xvii
 * pass a locale and options, the forms the console's source scan let through before v1.191.1's
 * review; the probe of the screens and the widened scan each kill them. V1-xviii to V1-xx are the
 * shade fixture v1.191.1 rewrote: its two-Core gap case passed the summed fleet, and its 4/4
 * clean/shaded split could not tell the p90 from the median.
 *
 *   cd server && node ../scripts/mutate-v1191-1.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALM = resolve(REPO, 'server/src/telnet/plant/alm.ts');
const BUS = resolve(REPO, 'server/src/telnet/plant/bus.ts');
const INDEX = resolve(REPO, 'server/src/index.ts');
const WEB_SITE_TIME = resolve(REPO, 'web/src/siteTime.ts');
const TODAY = resolve(REPO, 'web/src/cards/TodaySummary.tsx');
const DETAIL = resolve(REPO, 'web/src/cards/ForecastDetail.tsx');
const CARD = resolve(REPO, 'web/src/cards/ForecastCard.tsx');
const SCADA = resolve(REPO, 'server/src/telnet/plant/scada.ts');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const SUBSET = [
  'test/consoleSiteClock.test.ts',
  'test/webSiteTime.test.ts',
  'test/dashboardFreshness.test.ts',
  'test/todayBridge.test.ts',
  'test/shadeReportPerCore.test.ts',
];

const MUTANTS = [
  {
    id: 'V1-i. ★★ the ALARM LIST divider is back on the host clock',
    file: ALM,
    find: '  out.push(divider(`ALARM LIST — ${alerts.length} active  ·  ${fmtSiteHms(stamp)}`, W));',
    to: '  out.push(divider(`ALARM LIST — ${alerts.length} active  ·  ${new Date(stamp).toTimeString().slice(0, 8)}`, W)); /* MUTANT */',
    why: 'With the site zone not the host\'s, the ALARM screen\'s clock disagrees with the onset stamps listed under it.',
  },
  {
    id: 'V1-ii. ★★ the MAIN BUS divider is back on the host clock',
    file: BUS,
    find: '${fmtSiteHms(data.snap.generatedAt ?? Date.now())}${qualTag}',
    to: '${new Date(data.snap.generatedAt ?? Date.now()).toTimeString().slice(0, 8) /* MUTANT */}${qualTag}',
    why: 'The BUS screen\'s clock reads the container\'s time while the console\'s other stamps read the site\'s.',
  },
  {
    id: 'V1-iii. ★★★ fmtLocaleIn drops the zone',
    file: WEB_SITE_TIME,
    find: '    return new Date(ms).toLocaleString([], { ...fields, timeZone: zone });',
    to: '    return new Date(ms).toLocaleString([], { ...fields }); /* MUTANT */',
    why: 'Every label written through it (the Today card\'s "since", the dashboard forecast) shows the browser\'s clock again.',
  },
  {
    id: 'V1-iv. ★★ the Today card writes "since" in the browser zone',
    file: TODAY,
    find: "            {data ? `${(coverage * 100).toFixed(0)}% measured${since ? ` · ${since}` : ''}` : '—'}",
    to: "            {data ? `${(coverage * 100).toFixed(0)}% measured · since ${new Date(data.sinceMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—'} {/* MUTANT */}",
    why: 'A viewer whose browser is not in the site zone reads "since 03:00 AM" over the site\'s day.',
  },
  {
    id: 'V1-v. ★ /api/summary/today stops stamping the site zone',
    file: INDEX,
    find: '{ ...(totals as object), dayEndMs, siteTimeZone: siteTimeZone() }',
    to: '{ ...(totals as object), dayEndMs /* MUTANT */ }',
    why: 'The card has no zone to write the time in and shows none.',
  },
  {
    id: 'V1-vi. ★★★ zonedHourIn reads the browser clock',
    file: WEB_SITE_TIME,
    find: '    const h = zonedParts(ms, zone).hour;',
    to: '    const h = new Date(ms).getHours(); /* MUTANT */',
    why: 'Every forecast hour on the Solar page is labelled hours apart from the site-hour table beside it.',
  },
  {
    id: 'V1-vii. ★★ the forecast hour rows are labelled from the browser clock',
    file: DETAIL,
    find: '<td className="py-1 pr-4 text-ink font-medium">{tsHourIn(h.ts, zone)}</td>',
    to: '<td className="py-1 pr-4 text-ink font-medium">{fmtHour(new Date(h.ts).getHours()) /* MUTANT */}</td>',
    why: 'The hourly projection rows name other hours than the learned response table on the same page.',
  },
  {
    id: 'V1-viii. ★★ the Solar page takes the browser\'s zone, not the payload\'s',
    file: DETAIL,
    find: '  const zone = fc.siteTimeZone;',
    to: '  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; /* MUTANT */',
    why: 'The projected low and the hour rows read the viewer\'s clock, not the site\'s.',
  },
  {
    id: 'V1-ix. ★ /api/forecast stops stamping the site zone',
    file: INDEX,
    find: '{ ...fc, siteTimeZone: siteTimeZone() }',
    to: '{ ...fc /* MUTANT */ }',
    why: 'Both forecast cards have no zone and show no hours.',
  },
  {
    id: 'V1-x. ★ the dashboard forecast axis is in the browser zone',
    file: CARD,
    find: "tickFormatter={(t) => fmtLocaleIn(t, zone, { hour: 'numeric' }) ?? ''}",
    to: "tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' }) /* MUTANT */}",
    why: 'The chart\'s hours sit hours away from the site\'s clock for a viewer elsewhere.',
  },
  {
    id: 'V1-xi. ★★ the dashboard forecast\'s projected-low time is in the browser zone',
    file: CARD,
    find: "  const lowAt = fc?.minProjectedSocTs ? fmtLocaleIn(fc.minProjectedSocTs, zone, { weekday: 'short', hour: 'numeric' }) : null;",
    to: "  const lowAt = fc?.minProjectedSocTs ? new Date(fc.minProjectedSocTs).toLocaleString([], { weekday: 'short', hour: 'numeric' }) : null; /* MUTANT */",
    why: 'The dashboard names another hour for the battery\'s projected low than the server\'s own dip warning.',
  },
  {
    id: 'V1-xii. ★★ the Solar page\'s hour rows are not handed the zone',
    file: DETAIL,
    find: '<HourRow key={h.ts} h={h} zone={zone} />',
    to: '<HourRow key={h.ts} h={h} zone={undefined /* MUTANT */} />',
    why: 'Every hourly projection row reads "—" on every install, the reference install included; the count of zone-taking calls is unchanged.',
  },
  {
    id: 'V1-xiii. ★ the Today card\'s header drops the "since" time',
    file: TODAY,
    find: "            {data ? `${(coverage * 100).toFixed(0)}% measured${since ? ` · ${since}` : ''}` : '—'}",
    to: "            {data ? `${(coverage * 100).toFixed(0)}% measured` : '—' /* MUTANT */}",
    why: 'The card computes the site-clock "since" and never shows it.',
  },
  {
    id: 'V1-xiv. ★ the dashboard forecast\'s projected-low tile drops its time',
    file: CARD,
    find: "sub={lowAt ? `at ${lowAt}` : ''}",
    to: "sub={'' /* MUTANT */}",
    why: 'The tile computes the site-clock time of the projected low and never shows it.',
  },
  {
    id: 'V1-xv. ★★ the CONSOLE alarm banner formats its time on the host clock (with a locale and options)',
    file: SCADA,
    find: '    const tstr = fmtSiteHms(newest.ts); // v1.191.0 (T15) — site zone, not the host clock',
    to: "    const tstr = new Date(newest.ts).toLocaleTimeString('en-US', { hour12: false }); /* MUTANT */",
    why: 'The banner\'s alarm time reads the container\'s clock while the alarm rows read the site\'s.',
  },
  {
    id: 'V1-xvi. ★★ the CONSOLE status header formats its stamp on the host clock (with a locale and options)',
    file: SCADA,
    find: '  const ts = fmtSiteStamp(Date.now());',
    to: "  const ts = new Date().toLocaleString('en-US', { hour12: false }); /* MUTANT */",
    why: 'The console\'s headline clock reads the container\'s time, hours from the site\'s.',
  },
  {
    id: 'V1-xvii. ★★ the alarm rows format their onset on the host clock, in the same form',
    file: ALM,
    find: '  const fmtTs = (ms: number) => fmtSiteStamp(ms, true);',
    to: "  const fmtTs = (ms: number) => new Date(ms).toLocaleString('sv-SE', { hour12: false }); /* MUTANT */",
    why: 'Each alarm\'s onset is stamped on the container\'s clock in the same YYYY-MM-DD HH:MM:SS text, so only the hour gives it away.',
  },
  {
    id: 'V1-xviii. ★★ the shade report sums the home Cores into one fleet series again',
    file: ANALYTICS,
    find: '  for (const pvByEpoch of homeCorePvMaps) {',
    to: '  const fleetPvByEpoch = new Map<number, number>(); /* MUTANT */\n  for (const m of homeCorePvMaps) for (const [k, v] of m) fleetPvByEpoch.set(k, (fleetPvByEpoch.get(k) ?? 0) + v);\n  for (const pvByEpoch of (homeCorePvMaps.length > 0 ? [fleetPvByEpoch] : [])) {',
    why: 'One dark Core of three reads as a 33 % shortfall on every clear hour and about 1750 kWh a year of phantom shade.',
  },
  {
    id: 'V1-xix. ★ the shade report\'s clean reference is the median, not the 90th percentile',
    file: ANALYTICS,
    find: '      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];',
    to: '      const p90 = sorted[Math.floor(sorted.length * 0.5)] ?? sorted[sorted.length - 1]; /* MUTANT */',
    why: 'Shade on most of the recent days becomes the reference and is no longer reported.',
  },
  {
    id: 'V1-xx. ★ the shade report\'s reference keeps a Core\'s zero (gap) hours',
    file: ANALYTICS,
    find: "      if (!Number.isFinite(coeff) || coeff <= 0) continue; // drop this Core's gap hour",
    to: '      if (!Number.isFinite(coeff)) continue; /* MUTANT */',
    why: 'A Core dark on most days gets a reference from its few lit days and books its dark days as a phantom annual shortfall.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1191-1', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
