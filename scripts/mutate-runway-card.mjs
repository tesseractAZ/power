#!/usr/bin/env node
/**
 * mutate-runway-card.mjs — committed harness for the v1.177.0 Runway card wording and the
 * projection fields behind it (server/src/analytics.ts computeRunway + getDayForecast's
 * display PV sum; web/src/cards/runwayText.ts, RunwayCard.tsx, ForecastDetail.tsx).
 *
 * WHY COMMITTED: every defect here was a sentence that read as reassurance and was not
 * true — "no dip / PV keeps up" over a 52 kWh drain, "grid is carrying the load" at 0 W,
 * "last-hour load" over a curve twice that, "1-hour average" over a carried-forward value.
 * None of them breaks a build; each only misleads the operator reading the card that
 * exists for the moment the grid goes away.
 *
 *   node scripts/mutate-runway-card.mjs
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
const TEXT = resolve(REPO, 'web/src/cards/runwayText.ts');
const CARD = resolve(REPO, 'web/src/cards/RunwayCard.tsx');
const FD = resolve(REPO, 'web/src/cards/ForecastDetail.tsx');

const SUBSET = ['test/runwayTrough.test.ts', 'test/runwayCardText.test.ts', 'test/displayPvContract.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the simulation stops tracking its lowest point',
    file: AN,
    find: '    if (stateKwh < troughKwh) {',
    to: '    if (false) { /* MUTANT */',
    why: 'The card falls back to asserting the pool holds up while it drains 52 kWh toward the floor.',
  },
  {
    id: 'ii. \u2605\u2605 the trough starts from full capacity, not the pool now',
    file: AN,
    find: '  let troughKwh = backupRemainingKwh;',
    to: '  let troughKwh = backupFullKwh; /* MUTANT */',
    why: 'A pool that only rises reports a dip below where it already is.',
  },
  {
    id: 'iii. \u2605\u2605 every recent-load fallback is labelled a 1-hour average',
    file: AN,
    find: "    recentLoadBasis = liveLoadWatts > 0 ? 'live' : loadPts.length === 1 ? 'single-sample' : 'carried';",
    to: '    /* MUTANT */',
    why: 'An instantaneous reading, or a value carried forward from an earlier compute, is captioned as a measured average.',
  },
  {
    id: 'iv. \u2605\u2605\u2605 the "not a live countdown" note shows for a grid the resolver distrusts',
    file: TEXT,
    find: '  if (grid?.backstopping !== true) return null;',
    to: '  if (grid?.present !== true && grid?.backstopping !== true) return null; /* MUTANT */',
    why: 'At the reserve floor, with a declared grid the resolver has ruled NOT backstopping and the alarm critical, the card tells the operator to discount the countdown.',
  },
  {
    id: 'iv-b. \u2605\u2605 backstopping (presence) is shown as the grid supplying the house',
    file: TEXT,
    find: "  return `${grid.importLive === true ? 'grid is supplying the house'",
    to: "  return `${grid.backstopping === true /* MUTANT */ ? 'grid is supplying the house'",
    why: '"grid is supplying the house" at 0 W imported, beside an Energy flow card reading GRID STANDBY.',
  },
  {
    id: 'iv-c. \u2605 a tight trough is coloured more alarming than a real crossing',
    file: CARD,
    find: "      ? (troughTight(runway) ? 'text-ink' : 'text-ok')",
    to: "      ? (troughTight(runway) ? 'text-warn' : 'text-ok') /* MUTANT */",
    why: 'A projection that crosses nothing reads amber while a reserve crossing 14 h out reads neutral.',
  },
  {
    id: 'iv-d. \u2605 the trough time is the end of the hour, not the empty crossing',
    file: AN,
    find: '      troughH = stateKwh === 0 && hoursToEmpty != null ? hoursToEmpty : h + 1;',
    to: '      troughH = h + 1; /* MUTANT */',
    why: 'The payload says the pool bottoms out up to an hour after its own emptyAtMs.',
  },
  {
    id: 'iv-e. \u2605\u2605 the display model is refit even with no Core missing',
    file: AN,
    find: '  const restoredSolarModel = missingConnectedSns.length === 0',
    to: '  const restoredSolarModel = false /* MUTANT */',
    why: 'After any partial-fleet day the display model is fit on ungated hours: Home Assistant and the dashboard disagree on a fully reporting fleet.',
  },
  {
    id: 'iv-f. \u2605 the low-SoC note counts EV load predicted after the low',
    file: FD,
    find: "${evBeforeLowWh > 0 ? ' · incl. predicted EV' : ''}",
    to: "${evWh > 0 /* MUTANT */ ? ' · incl. predicted EV' : ''}",
    why: 'A dawn low is labelled as including an EV session predicted for the afternoon.',
  },
  {
    id: 'v. \u2605\u2605\u2605 "forecast PV keeps up" whenever the floor is not crossed',
    file: TEXT,
    find: '  if (r.troughKwh >= r.backupRemainingKwh - 0.05) return',
    to: '  if (true /* MUTANT */) return',
    why: 'The v1.176 wording, back: a 78 \u2192 26 kWh drain described as PV keeping up with the load.',
  },
  {
    id: 'vi. \u2605\u2605 a trough just above the floor is green',
    file: TEXT,
    find: 'export const TROUGH_TIGHT_FRAC = 0.15;',
    to: 'export const TROUGH_TIGHT_FRAC = 0; /* MUTANT */',
    why: 'A pool projected to bottom out 11 kWh above the floor reads as comfortably safe.',
  },
  {
    id: 'vii. \u2605 the caption ignores the basis',
    file: TEXT,
    find: "    case 'live': return 'live reading';",
    to: "    case 'live': return '1-hour average'; /* MUTANT */",
    why: 'A post-restart live reading is labelled a 1-hour average.',
  },
  {
    id: 'viii. \u2605\u2605 the display PV sum loses its bias correction again',
    file: AN,
    find: '    restoredPvSum += restoredCeil != null ? Math.min(pv * pvBiasFactor, restoredCeil) : pv * pvBiasFactor;',
    to: '    restoredPvSum += pv; /* MUTANT */',
    why: 'The dashboard and Home Assistant disagree on the next-24 h PV by exactly the bias factor.',
  },
  {
    id: 'ix. \u2605 the header names the fallback model, not the one in use',
    file: CARD,
    find: "{runway.loadModelDegraded ? 'last-hour load' : 'typical load'} + next-",
    to: "{'last-hour load' /* MUTANT */} + next-",
    why: '"last-hour load" over a projection driven by a weekday curve 2.2\u00d7 larger.',
  },
  {
    id: 'x. \u2605 the Solar tab\u2019s forecast load does not say it includes predicted EV',
    file: FD,
    find: "sub={evWh > 0 ? `incl. ${kwh(evWh)} predicted EV` : 'no EV charging predicted'}",
    to: 'sub={undefined /* MUTANT */}',
    why: 'Two different "load over the next 24 h" figures on two tabs with nothing saying why.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-runway-card', mutants: MUTANTS, subset: SUBSET, root: REPO });
