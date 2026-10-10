#!/usr/bin/env node
/**
 * mutate-v1187-1e.mjs — committed harness for v1.187.1 (soiling estimate): the estimate measures
 * the array, not the packs, and it is never spoken.
 *
 * (1) computeSoiling counted the hours a home Core's pack was full as dirty panels: the DPU backs
 * its MPPTs off to the load near its ceiling (2026-09-30 13:00, Core 1 2766 → 643 W under a clear
 * 786 W/m²). Three such days in the last five read as a 47.9% drop. Each Core's charge-taper hours
 * (chargeTaperHoursFromPts: the hour's highest SoC at or above saturationThresholdPct of the
 * recorded, else live, ceiling, or no SoC recorded) are now left out, and a day that lost any
 * counts only when the hours left reach the coverage bar. The forecast and the decomposition (per
 * Core and per hour, and so the wash card) read the same hours. Mutants i-iv, x-xxv.
 *
 * (2) The soiling fits paired PV hour he with the radiation labelled he (the previous hour's sun).
 * soilingClearSkyHour pairs it with coveringRadiationEpoch(he), clear only when the cloud reading
 * at both labels is ≤ 25%, a missing label not clear, and only for completed hours. Mutants v-ix,
 * xxvi.
 *
 * (3) soiling-pv raised and voiced a yellow ("Medium priority alarm …"). It carries
 * `audible: false` (card and push kept), and conditionFromAlerts excludes the id as a second
 * guard. Mutants xxvii-xxviii.
 *
 * Review fixes. The recent pool must be recent: fewer than three of its days in the last ten →
 * recentCovered false (a pool of pre-rain days read 13.9% on washed panels), and the wash card
 * requires recentCovered as the alert does (xxix-xxxvi). An hour pairs only once its covering
 * label predates the live cache's fetch (soilingPairedUntil, xxxvii-xliv). Each Core keeps its own
 * taper set whatever the order (xlv-xlvii).
 *
 *   node scripts/mutate-v1187-1e.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AN = resolve(SERVER, 'src/analytics.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const RI = resolve(SERVER, 'src/repairIssues.ts');

const SUBSET = [
  'test/soilingChargeTaper.test.ts',
  'test/analytics.test.ts',
  'test/finalQueueV123.test.ts',
  'test/realizedGhiStage2.test.ts',
  'test/repairIssues.test.ts',
];

const MUTANTS = [
  /* ── (1) the taper hours in computeSoiling ────────────────────────────── */
  {
    id: 'i. ★★★ computeSoiling counts the taper hours',
    file: AN,
    find: '    if (taperHours.has(he)) { taperDays.add(day); taperCount++; continue; }',
    to: '    /* MUTANT */',
    why: 'The 09-30 incident: three full-pack days in the last five read as a ~48% drop, a spoken warning.',
  },
  {
    id: 'ii. ★★★ a full-pack day is not remembered as one (its morning sliver is admitted)',
    file: AN,
    find: '    if (taperHours.has(he)) { taperDays.add(day); taperCount++; continue; }',
    to: '    if (taperHours.has(he)) { taperCount++; continue; } /* MUTANT */',
    why: 'Morning slivers enter the p90 baseline: where the clean coefficient is higher in the morning, a clean array reads ~15% soiled.',
  },
  {
    id: 'iii. ★★★ the coverage rule for a full-pack day is gone',
    file: AN,
    find: '  const days = candidates.filter((d) => d.hours >= covBar || !taperDays.has(d.day));',
    to: '  const days = candidates; /* MUTANT */',
    why: 'As ii.',
  },
  {
    id: 'iv. ★★ the coverage bar is exclusive for a full-pack day',
    file: AN,
    find: '  const days = candidates.filter((d) => d.hours >= covBar || !taperDays.has(d.day));',
    to: '  const days = candidates.filter((d) => d.hours > covBar || !taperDays.has(d.day)); /* MUTANT */',
    why: 'A full-pack day with exactly the bar\'s hours — which the recent pool itself accepts — is thrown away.',
  },
  /* ── (2) pairing ──────────────────────────────────────────────────────── */
  {
    id: 'v. ★★★ PV hour he pairs with the label he again',
    file: AN,
    find: '  const covering = wxByHour.get(coveringRadiationEpoch(he));',
    to: '  const covering = wxByHour.get(he); /* MUTANT */',
    why: 'The previous hour\'s sun: morning coefficients ×1.2-1.4, afternoon ×0.6-0.9; a morning-heavy day inflates the baseline.',
  },
  {
    id: 'vi. ★★ the cloud reading at the START of the hour is not checked',
    file: AN,
    find: '  if (start.cloudCoverPct > SOILING_MAX_CLOUD_PCT) return null;',
    to: '  /* MUTANT */',
    why: 'An hour that began under cloud is a clear-sky sample.',
  },
  {
    id: 'vii. ★★ the cloud reading at the END of the hour is not checked',
    file: AN,
    find: '  if (covering.cloudCoverPct > SOILING_MAX_CLOUD_PCT) return null;',
    to: '  /* MUTANT */',
    why: 'An hour that ended under cloud is a clear-sky sample.',
  },
  {
    id: 'viii. ★★ a missing start reading counts as clear',
    file: AN,
    find: '  if (!start || !covering) return null;',
    to: '  if (!covering) return null; if (start == null) return covering; /* MUTANT */',
    why: 'An hour whose cloud cannot be checked at one end is a clear-sky sample.',
  },
  {
    id: 'ix. ★★ the hour in progress pairs with a forecast',
    file: AN,
    find: '  if ((he + 1) * 3_600_000 > pairedUntilMs) return null;',
    to: '  /* MUTANT */',
    why: 'A partial hour\'s PV against the forecast radiation of the whole hour enters the newest day.',
  },
  {
    id: 'x. ★ a just-completed hour is still treated as in progress',
    file: AN,
    find: '  if ((he + 1) * 3_600_000 > pairedUntilMs) return null;',
    to: '  if ((he + 1) * 3_600_000 >= pairedUntilMs) return null; /* MUTANT */',
    why: 'Off by one at the hour boundary.',
  },
  /* ── the taper hours themselves ───────────────────────────────────────── */
  {
    id: 'xi. ★★★ an hour with no SoC recorded is treated as headroom',
    file: AN,
    find: '    if (soc == null || soc >= saturationThresholdPct(ceiling)) out.add(he);',
    to: '    if (soc != null && soc >= saturationThresholdPct(ceiling)) out.add(he); /* MUTANT */',
    why: 'Unknown is counted as unshed: a full pack whose SoC went unrecorded reads as soiling.',
  },
  {
    id: 'xii. ★★ the band\'s lower edge is exclusive',
    file: AN,
    find: '    if (soc == null || soc >= saturationThresholdPct(ceiling)) out.add(he);',
    to: '    if (soc == null || soc > saturationThresholdPct(ceiling)) out.add(he); /* MUTANT */',
    why: 'Disagrees with the curtailment engine\'s predicate (socAvg < threshold is the only unsaturated case).',
  },
  {
    id: 'xiii. ★★★ the hour\'s MEAN SoC, not its highest',
    file: AN,
    find: '  const socPeak = new Map<number, number>();\n  for (const p of socPts) {\n    const he = Math.floor(p.ts / 3_600_000);\n    const prev = socPeak.get(he);\n    if (prev == null || p.value > prev) socPeak.set(he, p.value);\n  }\n',
    to: '  const socPeak = pvHourlyFromPts([...socPts]); /* MUTANT */\n',
    why: 'An hour that entered the band in its last minutes (86, 88, 91) is counted although its PV was already shed.',
  },
  {
    id: 'xiv. ★★ the hour\'s FIRST SoC, not its highest',
    file: AN,
    find: '    if (prev == null || p.value > prev) socPeak.set(he, p.value);',
    to: '    if (prev == null) socPeak.set(he, p.value); /* MUTANT */',
    why: 'As xiii.',
  },
  {
    id: 'xv. ★★ the recorded ceiling is ignored',
    file: AN,
    find: '    const ceiling = recorded != null && recorded > 0 ? recorded : liveCeilingPct;',
    to: '    const ceiling = liveCeilingPct; /* MUTANT */',
    why: 'An hour charged to a lower ceiling (80: band from 70) is read against today\'s.',
  },
  {
    id: 'xvi. ★ a recorded 0 is taken as the ceiling',
    file: AN,
    find: '    const ceiling = recorded != null && recorded > 0 ? recorded : liveCeilingPct;',
    to: '    const ceiling = recorded != null ? recorded : liveCeilingPct; /* MUTANT */',
    why: 'A zero reading displaces the live ceiling (the default 100 applies instead).',
  },
  {
    id: 'xvii. ★★ the live ceiling is ignored',
    file: AN,
    find: '    const ceiling = recorded != null && recorded > 0 ? recorded : liveCeilingPct;',
    to: '    const ceiling = recorded != null && recorded > 0 ? recorded : null; /* MUTANT */',
    why: 'A Core set below 100 with no ceiling history is read against 100.',
  },
  /* ── wiring: the forecast ─────────────────────────────────────────────── */
  {
    id: 'xviii. ★★★ the forecast passes no taper hours',
    file: AN,
    find: '    soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps, wxByHour, homeCoreTaperHours, now, soilingPairedUntil(now, weather)) : null,',
    to: '    soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps, wxByHour, [], now, soilingPairedUntil(now, weather)) : null, /* MUTANT */',
    why: 'The published estimate (alert, HA sensor) is the v1.187.0 one.',
  },
  {
    id: 'xix. ★★★ the home Cores\' query carries no SoC',
    file: AN,
    find: "const SOILING_CORE_METRICS = ['pv_total', 'pv_high', 'pv_low', 'soc', 'chg_max_soc'];",
    to: "const SOILING_CORE_METRICS = ['pv_total', 'pv_high', 'pv_low']; /* MUTANT */",
    why: 'Every hour is unknown and left out: the estimate is gone.',
  },
  {
    id: 'xx. ★★ the forecast ignores a Core\'s live ceiling',
    file: AN,
    find: "      homeCoreTaperHours.push(chargeTaperHoursFromPts(pvE, pvM.get('soc') ?? [], pvM.get('chg_max_soc') ?? [], d.projection.chgMaxSoc ?? null));",
    to: "      homeCoreTaperHours.push(chargeTaperHoursFromPts(pvE, pvM.get('soc') ?? [], pvM.get('chg_max_soc') ?? [], null)); /* MUTANT */",
    why: 'A Core at a 95 ceiling with no history: its taper from 85 is read as from 90.',
  },
  {
    id: 'xxi. ★★★ the fleet estimate drops each Core\'s taper hours',
    file: AN,
    find: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[i], nowMs, pairedUntilMs))',
    to: '    .map((m) => computeSoiling(m, wxByHour, undefined, nowMs, pairedUntilMs)) /* MUTANT */',
    why: 'As xviii.',
  },
  /* ── wiring: the decomposition (and the wash card) ─────────────────────── */
  {
    id: 'xxii. ★★★ the per-Core rows count the taper hours',
    file: AN,
    find: '    const est = computeSoiling(pvE, wxByHour, taper, now, pairedUntil);',
    to: '    const est = computeSoiling(pvE, wxByHour, undefined, now, pairedUntil); /* MUTANT */',
    why: 'The 09-30 "Wash solar panels (~48.6% output drop on Core 5)" card.',
  },
  {
    id: 'xxiii. ★★ the decomposition ignores a Core\'s live ceiling',
    file: AN,
    find: '      d.projection.chgMaxSoc ?? null,\n    );\n    series.set(d.sn, { pvE, taper });',
    to: '      null, /* MUTANT */\n    );\n    series.set(d.sn, { pvE, taper });',
    why: 'As xx, for the wash card.',
  },
  {
    id: 'xxiv. ★★ the per-hour shape counts hours a home Core was in its taper',
    file: AN,
    find: '    if (fleetTaper.has(he)) continue;',
    to: '    /* MUTANT */',
    why: 'The 09-30 shape: hours 13-16 read 26-44% while hours 9-12 read about 0.',
  },
  {
    id: 'xxv. ★★ the fleet taper set is never filled',
    file: AN,
    find: '    for (const he of taper) fleetTaper.add(he);',
    to: '    /* MUTANT */',
    why: 'As xxiv.',
  },
  {
    id: 'xxvi. ★★ the per-hour shape pairs by label again',
    file: AN,
    find: '    const wx = soilingClearSkyHour(wxByHour, he, pairedUntil);\n    if (!wx || wx.radiationWm2 < PERHOUR_MIN_GHI_WM2) continue;',
    to: '    const wx = wxByHour.get(he); /* MUTANT */\n    if (!wx || wx.cloudCoverPct > 25 || wx.radiationWm2 < PERHOUR_MIN_GHI_WM2) continue;',
    why: 'As the days shorten the morning ratios drift: the shape reports a drop on a clean array.',
  },
  /* ── (3) never on the speakers ────────────────────────────────────────── */
  {
    id: 'xxvii. ★★★ soiling-pv is audible',
    file: AN,
    find: "      audible: false,\n      category: 'Solar',",
    to: "      category: 'Solar', /* MUTANT */",
    why: 'When another warning raises a yellow, the soiling estimate can be the alert voiced.',
  },
  {
    id: 'xxviii. ★★★ the condition counts soiling-pv',
    file: BC,
    find: "      !a.id.startsWith('soiling-pv') &&",
    to: '      true /* MUTANT */ &&',
    why: 'A soiling-pv without its flag raises a yellow: the 09-30 spoken "Medium priority alarm".',
  },
  /* ── (review) the recent pool must be recent; the wash card requires it ── */
  {
    id: 'xxix. ★★★ the recency gate is gone',
    file: AN,
    find: '  const recentCovered = coveredEnough && inWindow >= SOILING_RECENT_MIN_DAYS;',
    to: '  const recentCovered = coveredEnough; /* MUTANT */',
    why: 'A pool of days from before a rain reads 13.9% on washed panels (a wash card), or calls a newly dimmed array clean.',
  },
  {
    id: 'xxx. ★★ two recent days are enough',
    file: AN,
    find: '  const recentCovered = coveredEnough && inWindow >= SOILING_RECENT_MIN_DAYS;',
    to: '  const recentCovered = coveredEnough && inWindow >= SOILING_RECENT_MIN_DAYS - 1; /* MUTANT */',
    why: 'Two recent days of five: the median can be a stale day.',
  },
  {
    id: 'xxxi. ★★ three recent days are not enough',
    file: AN,
    find: '  const recentCovered = coveredEnough && inWindow >= SOILING_RECENT_MIN_DAYS;',
    to: '  const recentCovered = coveredEnough && inWindow > SOILING_RECENT_MIN_DAYS; /* MUTANT */',
    why: 'A recent window of three clear days goes quiet: a real loss is reported later than it can be.',
  },
  {
    id: 'xxxii. ★★ the window is eleven days',
    file: AN,
    find: 'const SOILING_RECENT_WINDOW_DAYS = 10;',
    to: 'const SOILING_RECENT_WINDOW_DAYS = 11; /* MUTANT */',
    why: 'A pool whose newest day is 8 days old counts as recent.',
  },
  {
    id: 'xxxiii. ★★ the window is nine days',
    file: AN,
    find: 'const SOILING_RECENT_WINDOW_DAYS = 10;',
    to: 'const SOILING_RECENT_WINDOW_DAYS = 9; /* MUTANT */',
    why: 'Three clear days 7-9 days ago are not recent: quieter than specified.',
  },
  {
    id: 'xxxiv. ★★ the pool\'s age is judged on the pairing bound, not the clock',
    file: AN,
    find: '  const recentSince = nowMs - SOILING_RECENT_WINDOW_DAYS * 86_400_000;',
    to: '  const recentSince = pairedUntilMs - SOILING_RECENT_WINDOW_DAYS * 86_400_000; /* MUTANT */',
    why: 'A weather cache days old carries the ten-day window back with it.',
  },
  {
    id: 'xxxv. ★★★ the wash card ignores recentCovered',
    file: RI,
    find: '      (d) => d.dropPct != null && d.dropPct >= SOILING_CARD_DROP_PCT && d.cleanDays >= 6 && d.recentCovered,',
    to: '      (d) => d.dropPct != null && d.dropPct >= SOILING_CARD_DROP_PCT && d.cleanDays >= 6, /* MUTANT */',
    why: 'The 09-30 "Wash solar panels (~13.9% output drop on Core 1)" for panels the rain had washed.',
  },
  {
    id: 'xxxvi. ★★★ the decomposition reports every row as covered',
    file: AN,
    find: '      recentCovered: est?.recentCovered === true,',
    to: '      recentCovered: true, /* MUTANT */',
    why: 'As xxxv.',
  },
  /* ── (review) an hour pairs only once its covering label predates the fetch ── */
  {
    id: 'xxxvii. ★★★ soilingPairedUntil ignores the fetch',
    file: AN,
    find: '  return weather ? Math.min(nowMs, weather.fetchedAt) : nowMs;',
    to: '  return nowMs; /* MUTANT */',
    why: 'The newest day\'s last one or two hours pair with the cache\'s forecast radiation.',
  },
  {
    id: 'xxxviii. ★★ a fetch stamped ahead of the clock opens the hour in progress',
    file: AN,
    find: '  return weather ? Math.min(nowMs, weather.fetchedAt) : nowMs;',
    to: '  return weather ? weather.fetchedAt : nowMs; /* MUTANT */',
    why: 'A clock step back after a fetch pairs the hour in progress.',
  },
  {
    id: 'xxxix. ★★★ computeSoiling pairs up to the clock',
    file: AN,
    find: '    const wx = soilingClearSkyHour(wxByHour, he, pairedUntilMs);',
    to: '    const wx = soilingClearSkyHour(wxByHour, he, nowMs); /* MUTANT */',
    why: 'As xxxvii.',
  },
  {
    id: 'xl. ★★ the fleet estimate drops the pairing bound',
    file: AN,
    find: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[i], nowMs, pairedUntilMs))',
    to: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[i], nowMs)) /* MUTANT */',
    why: 'As xxxvii, for the published estimate.',
  },
  {
    id: 'xli. ★★★ the forecast pairs up to the clock',
    file: AN,
    find: '    soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps, wxByHour, homeCoreTaperHours, now, soilingPairedUntil(now, weather)) : null,',
    to: '    soiling: weather ? fleetSoilingFromDevices(homeCorePvMaps, wxByHour, homeCoreTaperHours, now, now) : null, /* MUTANT */',
    why: 'As xxxvii, for the alert and the HA sensor.',
  },
  {
    id: 'xlii. ★★ the per-Core rows pair up to the clock',
    file: AN,
    find: '    const est = computeSoiling(pvE, wxByHour, taper, now, pairedUntil);',
    to: '    const est = computeSoiling(pvE, wxByHour, taper, now, now); /* MUTANT */',
    why: 'As xxxvii, for the wash card.',
  },
  {
    id: 'xliii. ★★ the per-hour shape pairs up to the clock',
    file: AN,
    find: '    const wx = soilingClearSkyHour(wxByHour, he, pairedUntil);\n    if (!wx || wx.radiationWm2 < PERHOUR_MIN_GHI_WM2) continue;',
    to: '    const wx = soilingClearSkyHour(wxByHour, he, now); /* MUTANT */\n    if (!wx || wx.radiationWm2 < PERHOUR_MIN_GHI_WM2) continue;',
    why: 'As xxxvii, for the per-hour shape.',
  },
  {
    id: 'xliv. ★★ the decomposition\'s bound is the clock',
    file: AN,
    find: '  const pairedUntil = soilingPairedUntil(now, weather);',
    to: '  const pairedUntil = now; /* MUTANT */',
    why: 'As xlii and xliii.',
  },
  /* ── (review) each Core keeps its own taper set, in any order ─────────── */
  {
    id: 'xlv. ★★★ every Core gets the first Core\'s taper set',
    file: AN,
    find: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[i], nowMs, pairedUntilMs))',
    to: '    .map((m) => computeSoiling(m, wxByHour, taperHoursByCore[0], nowMs, pairedUntilMs)) /* MUTANT */',
    why: 'An early-filling Core judged on a later filler\'s set counts its shed hours: the 09-30 artifact returns.',
  },
  {
    id: 'xlvi. ★★★ the taper sets are matched in reverse order',
    file: AN,
    find: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[i], nowMs, pairedUntilMs))',
    to: '    .map((m, i) => computeSoiling(m, wxByHour, taperHoursByCore[taperHoursByCore.length - 1 - i], nowMs, pairedUntilMs)) /* MUTANT */',
    why: 'As xlv.',
  },
  {
    id: 'xlvii. ★★★ the forecast gives every home Core the first home Core\'s set',
    file: AN,
    find: "      homeCoreTaperHours.push(chargeTaperHoursFromPts(pvE, pvM.get('soc') ?? [], pvM.get('chg_max_soc') ?? [], d.projection.chgMaxSoc ?? null));",
    to: "      homeCoreTaperHours.push(homeCoreTaperHours[0] ?? chargeTaperHoursFromPts(pvE, pvM.get('soc') ?? [], pvM.get('chg_max_soc') ?? [], d.projection.chgMaxSoc ?? null)); /* MUTANT */",
    why: 'As xlv, for the published estimate.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-1e', mutants: MUTANTS, subset: SUBSET, root: REPO });
