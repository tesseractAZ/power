#!/usr/bin/env node
/**
 * mutate-forecast-display-basis.mjs — v1.195.0: the forecast card's RESTORED (display) basis while the
 * home Cores are dark, and its isolation from every alarm input.
 *
 * With every home Core offline in the cloud the alarm-facing forecast is 0 W in every hour and its SoC
 * walk drains toward 0%, and the dashboard's forecast cards printed exactly that. The build now keeps
 * the restored PV per hour (hoursDisplay) with a SoC walk on it (minProjectedSocDisplay), stepped
 * through the same function from the same start with the same load, and the cards show it labelled,
 * with the alarm basis beside it (web/src/cards/cardText.ts forecastView). Nothing on the alarm path
 * reads it.
 *
 *   Server  S-i..S-ix    (the walk's PV, drain and start; the count and what it counts; the no-history
 *                         null; the hour's PV and its model flag; v1.195.0: the walk's charge leg)
 *   Alarm   I-i..I-ii    (computeRunway and the dip alert never read the display fields)
 *   Web     W-i..W-xi    (the view's low, solar, typical day, chart, model flag and restored flag; the
 *                         cards' wiring: the Outlook, the tiles, the chart, the detail card's low)
 *
 *   node scripts/mutate-forecast-display-basis.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AN = resolve(REPO, 'server/src/analytics.ts');
const TXT = resolve(REPO, 'web/src/cards/cardText.ts');
const CARD = resolve(REPO, 'web/src/cards/ForecastCard.tsx');
const DET = resolve(REPO, 'web/src/cards/ForecastDetail.tsx');
const SUBSET = [
  'test/forecastDisplayBasis.test.ts',
  'test/runwayPvBasisGuard.test.ts',
  'test/darkFleetForecastSingleRead.test.ts',
  'test/auditLastThree.test.ts',
];

const MUTANTS = [
  /* ── the restored series and its walk ── */
  {
    id: 'S-i. ★★★ the display walk is fed the alarm PV',
    file: AN,
    find: '      socWhDisplay = stepSocWh(socWhDisplay, fullWh, restoredPvW, loadWs[k]);',
    to: '      socWhDisplay = stepSocWh(socWhDisplay, fullWh, hours[k].forecastPvW, loadWs[k]); /* MUTANT */',
    why: 'The card\'s restored low is the alarm\'s 0%-bound low again: the dark-fleet card still reads "Tight".',
  },
  {
    id: 'S-ii. ★★★ the display walk has its own drain, without the overhead',
    file: AN,
    find: '      socWhDisplay = stepSocWh(socWhDisplay, fullWh, restoredPvW, loadWs[k]);',
    to: '      socWhDisplay = Math.max(0, Math.min(fullWh, socWhDisplay + restoredPvW - loadWs[k] / RUNWAY_DISCHARGE_EFFICIENCY)); /* MUTANT */',
    why: 'The two walks diverge: with every Core reporting the card\'s low is no longer the alarm\'s.',
  },
  {
    id: 'S-iii. ★★ the display walk starts where the alarm walk ended',
    file: AN,
    find: '  let socWhDisplay = socWhStart;',
    to: '  let socWhDisplay = socWh; /* MUTANT */',
    why: 'The restored trajectory begins 24 hours of drain below the pool it claims to start from.',
  },
  {
    id: 'S-iv. ★★★ the restored Core count is never set',
    file: AN,
    find: '    restoredCoreCount,\n  };',
    to: '    restoredCoreCount: 0, /* MUTANT */\n  };',
    why: 'The card never knows it may show the restored basis: 0 kWh and 0% while the Cores are dark.',
  },
  {
    id: 'S-v. ★★ the restored low is a number with no PV history',
    file: AN,
    find: '    minProjectedSocDisplay: restoredPvSpan === 0 || minSocDisplay == null ? null : Math.round(minSocDisplay * 10) / 10,',
    to: '    minProjectedSocDisplay: minSocDisplay == null ? null : Math.round(minSocDisplay * 10) / 10, /* MUTANT */',
    why: 'A walk on a model-less 0 W is shown as a forecast.',
  },
  {
    id: 'S-vi. ★★★ the per-hour series carries the alarm PV',
    file: AN,
    find: '      forecastPvW: Math.round(restoredPvW),',
    to: '      forecastPvW: hours[k].forecastPvW, /* MUTANT */',
    why: 'The chart\'s solar area is 0 W in every hour beside a 45 kWh tile, and its hours no longer sum to it.',
  },
  {
    id: 'S-vii. ★★ the per-hour series carries the alarm model\'s flag',
    file: AN,
    find: '      projectedSocPct: socPctDisplay == null ? null : Math.round(socPctDisplay * 10) / 10,\n      modelled,',
    to: '      projectedSocPct: socPctDisplay == null ? null : Math.round(socPctDisplay * 10) / 10,\n      modelled: hours[k].modelled, /* MUTANT */',
    why: 'Every restored row on a dark fleet is badged "typical" beside a figure the fitted restored model made.',
  },
  {
    id: 'S-viii. ★★ every offline Core counts as restored, records or not',
    file: AN,
    find: '    if (spanMs > 0) restoredCoreCount++;',
    to: '    restoredCoreCount++; /* MUTANT */',
    why: 'With no PV recorded the card reads "Solar restored from 3 offline Cores\' records" beside "no PV history".',
  },
  {
    id: 'S-ix. ★★ the display walk credits a restored surplus at unity',
    file: AN,
    // v1.195.0 — v1.194.0's charge leg reaches this walk through the shared step (stepSocWh).
    find: '      socWhDisplay = stepSocWh(socWhDisplay, fullWh, restoredPvW, loadWs[k]);',
    to: '      socWhDisplay = Math.max(0, Math.min(fullWh, socWhDisplay + (restoredPvW - runwayDrainW(loadWs[k], poolBasis.overheadW)))); /* MUTANT */',
    why: 'The card\'s restored walk climbs 8 % faster across a sunny day than the alarm walk on the same PV (94.9 % → 97.7 % after a day of 3.75 kW).',
  },
  /* ── nothing on the alarm path reads it ── */
  {
    id: 'I-i. ★★★ computeRunway reads the display PV',
    file: AN,
    find: '      pvByHour.push((h.forecastPvW ?? 0) / 1000);',
    to: '      pvByHour.push((forecast.hoursDisplay?.[pvByHour.length]?.forecastPvW ?? h.forecastPvW ?? 0) / 1000); /* MUTANT */',
    why: 'The runway counts the dark Cores\' recorded solar as tomorrow\'s: the alarm under-warns during a wedge.',
  },
  {
    id: 'I-ii. ★★★ the projected-dip alert reads the display low',
    file: AN,
    find: '  if (df.minProjectedSoc != null && df.minProjectedSocTs != null && df.minProjectedSoc < df.reserveSoc) {',
    to: '  if (df.minProjectedSoc != null && df.minProjectedSocTs != null && (df.minProjectedSocDisplay ?? df.minProjectedSoc) < df.reserveSoc) { /* MUTANT */',
    why: 'The dip alert goes quiet on a restored figure the alarm basis does not support.',
  },
  /* ── the cards ── */
  {
    id: 'W-i. ★★★ the view\'s low is the alarm basis only',
    file: TXT,
    find: '    minSoc: restored ? (fc.minProjectedSocDisplay ?? null) : fc.minProjectedSoc,',
    to: '    minSoc: fc.minProjectedSoc, /* MUTANT */',
    why: 'With every Core dark the card reads a 0% low and "Tight" again.',
  },
  {
    id: 'W-ii. ★★★ the view\'s solar is the alarm basis only',
    file: TXT,
    find: '    pvWh: noPv ? null : restored ? (fc.forecastPvWhNext24Display ?? fc.forecastPvWhNext24) : fc.forecastPvWhNext24,',
    to: '    pvWh: noPv ? null : fc.forecastPvWhNext24, /* MUTANT */',
    why: 'The card reads 0 kWh of solar while Home Assistant shows the restored ~50 kWh.',
  },
  {
    id: 'W-iii. ★★ the chart draws the alarm series under the restored badge',
    file: TXT,
    find: '          ...h, forecastPvW: d.forecastPvW, projectedSocPct: d.projectedSocPct,',
    to: '          ...h, /* MUTANT */',
    why: 'The tiles and the chart disagree: a flat 0 W solar area under a 45 kWh tile.',
  },
  {
    id: 'W-iv. ★★ the restored flag ignores the count',
    file: TXT,
    find: '  const restored = (fc.restoredCoreCount ?? 0) > 0 && fc.hoursDisplay != null;',
    to: '  const restored = fc.hoursDisplay != null; /* MUTANT */',
    why: 'A fully reporting fleet is labelled "restored" with a duplicate dashed line.',
  },
  {
    id: 'W-v. ★★ the Outlook reads the alarm low beside the restored tiles',
    file: CARD,
    find: '              value={outlookOf(view!.minSoc, fc!.reserveSoc).label}',
    to: '              value={outlookOf(fc!.minProjectedSoc, fc!.reserveSoc).label} /* MUTANT */',
    why: 'The Outlook says "Tight" beside a projected low of 60%.',
  },
  {
    id: 'W-vi. ★★ the view\'s typical day is the alarm basis only',
    file: TXT,
    find: '    typicalWh: noPv ? null : restored ? (fc.typicalPvWhPerDayDisplay ?? fc.typicalPvWhPerDay) : fc.typicalPvWhPerDay,',
    to: '    typicalWh: noPv ? null : fc.typicalPvWhPerDay, /* MUTANT */',
    why: 'The solar tile\'s "typical 0.0 kWh/day" under a restored 45 kWh.',
  },
  {
    id: 'W-vii. ★★ the view drops the restored model\'s flag',
    file: TXT,
    find: '          ...(d.modelled != null ? { modelled: d.modelled } : {}),',
    to: '          /* MUTANT */',
    why: 'The detail card badges every restored row "typical".',
  },
  {
    id: 'W-viii. ★★ the card\'s solar tile reads the alarm basis',
    file: CARD,
    find: "              value={view!.pvWh != null ? `${(view!.pvWh / 1000).toFixed(1)} kWh` : '—'}",
    to: '              value={`${(fc!.forecastPvWhNext24 / 1000).toFixed(1)} kWh`} /* MUTANT */',
    why: '0.0 kWh of solar under the "restored" badge on a dark fleet.',
  },
  {
    id: 'W-ix. ★★ the card\'s projected-low tile reads the alarm basis',
    file: CARD,
    find: "              value={view!.minSoc != null ? fmtPct(view!.minSoc, 0) : '—'}",
    to: "              value={fc!.minProjectedSoc != null ? fmtPct(fc!.minProjectedSoc, 0) : '—'} /* MUTANT */",
    why: 'A 0% low on the tile beside a "Comfortable" Outlook.',
  },
  {
    id: 'W-x. ★★ the chart draws the alarm hours',
    file: CARD,
    find: '              <ComposedChart data={view!.hours}',
    to: '              <ComposedChart data={fc!.hours} /* MUTANT */',
    why: 'A flat 0 W solar area and no dashed line under the restored tiles.',
  },
  {
    id: 'W-xi. ★★ the detail card\'s projected-low tile reads the alarm basis',
    file: DET,
    find: "          value={view.minSoc != null ? `${view.minSoc}%` : '—'}",
    to: "          value={fc.minProjectedSoc != null ? `${fc.minProjectedSoc}%` : '—'} /* MUTANT */",
    why: 'The Predictive Insights page reads a 0% low while the dashboard reads 60%.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-forecast-display-basis', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
