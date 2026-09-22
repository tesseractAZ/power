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

const SUBSET = ['test/runwayTrough.test.ts', 'test/runwayCardText.test.ts'];

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
    id: 'iv. \u2605\u2605\u2605 grid PRESENCE is shown as the grid carrying the load',
    file: CARD,
    find: '  const gridFlowing = runway.grid?.importLive === true;',
    to: '  const gridFlowing = runway.grid?.backstopping === true; /* MUTANT */',
    why: '"grid is carrying the load" at 0 W imported, beside an Energy flow card reading GRID STANDBY.',
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

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-runway-card: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
