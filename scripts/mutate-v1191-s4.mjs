#!/usr/bin/env node
/**
 * mutate-v1191-s4.mjs — v1.191.0 lane A, S4: the site clock (siteTime.ts and its consumers).
 *
 *   S4-i     siteTimeZone ignores the SITE_TIMEZONE option (the chain starts at TZ)
 *   S4-ii    the fallback is 'UTC' instead of the default zone
 *   S4-iii   siteDayStartMs keeps the fixed −7 h (killed under Europe/Berlin in summer)
 *   S4-iv    siteNoonIso keeps 19:00Z (killed under Asia/Tokyo: the statistics land on the next day)
 *   S4-v     the idle-floor day starts at local midnight (nights split; killed under Tokyo and by G1)
 *   S4-vi    the MPC hour index is back on the host's getHours (killed with a UTC host, a Phoenix site)
 *   S4-vii   CA11: the statistics noon is written by toISOString (`…000Z`, not the importer's form)
 *   S4-viii  CA11: the statistics noon taken as local midnight + 12 h (an hour off on a DST day)
 *   S4-ix    CA19: a link of the legacy zone keeps its own name (US/Arizona becomes the model zone)
 *   S4-x     the per-slot offset cache ignores the zone (one zone's offsets serve another's)
 *   S4-xi    quiet hours judged on the host clock again (broadcast.ts and the push path)
 *   S4-xii   CA26: the coverage days step back 24 h at a time (an hour off across DST)
 *   S4-xiii  a difference from Home Assistant's zone is silent
 *   S4-xiv   the web formats the night-charge window in the browser's zone (T16)
 *
 *   cd server && node ../scripts/mutate-v1191-s4.mjs      (or from the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_TIME = resolve(REPO, 'server/src/siteTime.ts');
const SITE_TIME_HA = resolve(REPO, 'server/src/siteTimeHa.ts');
const ANALYTICS = resolve(REPO, 'server/src/analytics.ts');
const MPC = resolve(REPO, 'server/src/dispatch/mpc.ts');
const MONITOR = resolve(REPO, 'server/src/alertMonitor.ts');
const WEB_SITE_TIME = resolve(REPO, 'web/src/siteTime.ts');
const SUBSET = [
  'test/siteTime.test.ts',
  'test/siteTimeLiteral.test.ts',
  'test/webSiteTime.test.ts',
  'test/haStatistics.test.ts',
  'test/golden.test.ts',
];

const MUTANTS = [
  {
    id: 'S4-i. ★★★ siteTimeZone ignores the SITE_TIMEZONE option',
    file: SITE_TIME,
    find: "  const chain: Array<['SITE_TIMEZONE' | 'TZ', string | null | undefined]> = [['SITE_TIMEZONE', siteTimeZoneOption], ['TZ', tz]];",
    to: "  const chain: Array<['SITE_TIMEZONE' | 'TZ', string | null | undefined]> = [['TZ', tz]]; /* MUTANT */",
    why: 'An owner who sets Site Time Zone keeps the container zone: every local date, the tariff and the night window stay where they were.',
  },
  {
    id: 'S4-ii. ★★★ the fallback is UTC',
    file: SITE_TIME,
    find: "  return { zone: DEFAULT_SITE_TIME_ZONE, source: 'default', rejected, mappedFrom: null };",
    to: "  return { zone: 'UTC', source: 'default', rejected, mappedFrom: null }; /* MUTANT */",
    why: 'With TZ unset or unusable the plant runs on UTC: the night window and the digest move seven hours on the reference install.',
  },
  {
    id: 'S4-iii. ★★★ siteDayStartMs keeps the fixed −7 h',
    file: SITE_TIME,
    find: '  return zonedDayStartMs(ymd, siteTimeZone());\n}',
    to: "  const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d, 7); /* MUTANT */\n}",
    why: 'In Berlin the plan-date bounds, the coverage days and the day totals start at 09:00 local in summer.',
  },
  {
    id: 'S4-iv. ★★★ siteNoonIso keeps 19:00Z',
    file: SITE_TIME,
    find: '  return zonedNoonIso(ymd, siteTimeZone());',
    to: '  return `${ymd}T19:00:00+00:00`; /* MUTANT */',
    why: 'In Tokyo 19:00Z is 04:00 the NEXT day: every vendor-ledger statistic is imported one day late.',
  },
  {
    id: 'S4-v. ★★★ the idle-floor day starts at local midnight',
    file: ANALYTICS,
    find: 'export const IDLE_FLOOR_DAY_START_HOUR = 17;',
    to: 'export const IDLE_FLOOR_DAY_START_HOUR = 0; /* MUTANT */',
    why: 'Every idle night is split in two buckets: the standby trend fits half-night floors.',
  },
  {
    id: 'S4-vi. ★★★ the MPC hour index is back on the host clock',
    file: MPC,
    find: '  const startHour = siteHour(inputs.nowMs ?? Date.now());',
    to: '  const startHour = new Date(inputs.nowMs ?? Date.now()).getHours(); /* MUTANT */',
    why: 'The tariff vector is built on the site clock and indexed on the host clock: on a UTC host the plan prices every hour seven slots off.',
  },
  {
    id: 'S4-vii. ★★ CA11: the statistics noon written by toISOString',
    file: SITE_TIME,
    find: '  return `${utcYmd(hourStart)}T${pad2(new Date(hourStart).getUTCHours())}:00:00+00:00`;',
    to: '  return new Date(hourStart).toISOString(); /* MUTANT */',
    why: 'The import payload changes form (…T19:00:00.000Z) from the one every past row was written with.',
  },
  {
    id: 'S4-viii. ★★ CA11: the statistics noon taken as local midnight + 12 h',
    file: SITE_TIME,
    find: '  const noon = zonedWallTimeMs(ymd, 12, 0, zone);',
    to: '  const noon = zonedDayStartMs(ymd, zone) + 12 * HOUR_MS; /* MUTANT */',
    why: "On a DST change day the day's single statistics row lands at 11:00 or 13:00 local, not noon.",
  },
  {
    id: 'S4-ix. ★★★ CA19: a link of the legacy zone keeps its own name',
    file: SITE_TIME,
    find: "  'US/Arizona': DEFAULT_SITE_TIME_ZONE,",
    to: '  /* MUTANT */',
    why: "A container whose TZ is US/Arizona changes the tariff model's zone string (golden G2) and every printed zone.",
  },
  {
    id: 'S4-x. ★★ the per-slot offset cache ignores the zone',
    file: SITE_TIME,
    find: '  let byZone = OFFSET_BY_SLOT.get(zone);\n  if (!byZone) { byZone = new Map(); OFFSET_BY_SLOT.set(zone, byZone); }',
    to: "  let byZone = OFFSET_BY_SLOT.get('*');\n  if (!byZone) { byZone = new Map(); OFFSET_BY_SLOT.set('*', byZone); } /* MUTANT */",
    why: 'The first zone asked about decides every other zone\'s hours for the same instants.',
  },
  {
    id: 'S4-xi. ★★★ quiet hours judged on the host clock',
    file: MONITOR,
    find: '  const h = siteHour(now.getTime());',
    to: '  const h = now.getHours(); /* MUTANT */',
    why: 'On a host whose zone is not the site\'s, the quiet window (pushes and the audible announcements) shifts by the difference.',
  },
  {
    id: 'S4-xii. ★★ CA26: the coverage days step back 24 h at a time',
    file: ANALYTICS,
    find: '    const dayStart = siteShiftDaysMs(todayStartMs, -i);\n    const dayEnd = siteShiftDaysMs(dayStart, 1);\n    const daylight: number[] = [];',
    to: '    const dayStart = todayStartMs - i * 86_400_000; /* MUTANT */\n    const dayEnd = siteShiftDaysMs(dayStart, 1);\n    const daylight: number[] = [];',
    why: 'Across a DST change the hindcast days start an hour off local midnight and are keyed to the wrong instants.',
  },
  {
    id: 'S4-xiii. ★★ a difference from Home Assistant\'s zone is silent',
    file: SITE_TIME_HA,
    find: '  if (mismatch) {',
    to: '  if (false) { /* MUTANT */',
    why: 'An add-on running in a different zone from Home Assistant says nothing; times in pushes and HA entities disagree unexplained.',
  },
  {
    id: 'S4-xiv. ★★ the web writes the night-charge window in the browser zone',
    file: WEB_SITE_TIME,
    find: '    const p = zonedParts(ms, zone);\n    return `${String(p.hour).padStart(2, \'0\')}:${String(p.minute).padStart(2, \'0\')}`;',
    to: '    const p = zonedParts(ms, Intl.DateTimeFormat().resolvedOptions().timeZone); /* MUTANT */\n    return `${String(p.hour).padStart(2, \'0\')}:${String(p.minute).padStart(2, \'0\')}`;',
    why: 'A viewer outside the site\'s zone reads the window and the cancel deadline hours off.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1191-s4', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
