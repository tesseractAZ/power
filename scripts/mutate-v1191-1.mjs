#!/usr/bin/env node
/**
 * mutate-v1191-1.mjs — v1.191.1: the console's and the web's last host- and browser-clock labels.
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
 *
 * The console cases run the screens in child processes with a New York site on a Phoenix host and a
 * Phoenix site on a UTC host, so every mutant dies whatever the runner's own zone.
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
const SUBSET = [
  'test/consoleSiteClock.test.ts',
  'test/webSiteTime.test.ts',
  'test/dashboardFreshness.test.ts',
  'test/todayBridge.test.ts',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1191-1', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
