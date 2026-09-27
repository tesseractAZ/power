#!/usr/bin/env node
/**
 * mutate-v1186-2.mjs — committed harness for v1.186.2: the displayed battery net prefers the
 * MQTT stream over the REST poll's last-non-zero replay (the alarm path stays raw); curtailment
 * pairs an hour with the radiation value that covers it; a measured cloudy hour is not
 * curtailment; a day freezes only on sound membership and old-schema frozen days are dropped.
 *
 *   node scripts/mutate-v1186-2.mjs
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
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const MEMB = resolve(SERVER, 'src/shp2Membership.ts');
const GRID = resolve(SERVER, 'src/gridState.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const FREEZE = resolve(SERVER, 'src/curtailmentFreeze.ts');

const SUBSET = ['test/v1186_2.test.ts'];

const MUTANTS = [
  {
    id: '1.i ★★★ the displayed battery net ignores the stream',
    file: MEMB,
    find: '      const f = pk.liveFlow ?? pk;',
    to: '      const f = pk; /* MUTANT */',
    why: 'Each 60 s poll re-injects the pre-handover discharge: 1.44 kW shown beside grid = load.',
  },
  {
    id: '1.ii ★★ the store never records the stream flow',
    file: SNAP,
    find: "    if (source === 'mqtt') this.noteStreamPackFlow(sn, partial);",
    to: '    /* MUTANT */',
    why: 'liveFlow is never set, so the display falls back to the replayed poll value.',
  },
  {
    id: '1.iii ★★ a silent stream outranks the poll forever',
    file: SNAP,
    find: '      return r && now - r.atMs <= STREAM_FLOW_WINDOW_MS ? r : null;',
    to: '      return r ?? null; /* MUTANT */',
    why: 'A Core whose stream died shows its last streamed value instead of the fresh poll.',
  },
  {
    id: '1.iv ★★★ the at-floor discharge guard reads the display sum',
    file: GRID,
    find: '  const poolDischargingObserved = aggregateFleetFlow(input.devices).fleetBatteryNet > POOL_DISCHARGE_WATTS;',
    to: '  const poolDischargingObserved = aggregateFleetFlow(input.devices).fleetBatteryNetDisplay > POOL_DISCHARGE_WATTS; /* MUTANT */',
    why: 'The fail-loud alarm evidence is filtered by a display heuristic.',
  },
  {
    id: "2.i ★★★ curtailment pairs an hour with the preceding hour's sunlight",
    file: AN,
    find: '    (h) => Math.floor(h.ts / 3_600_000) === coveringRadiationEpoch(Math.floor(hourStart / 3_600_000)),',
    to: '    (h) => Math.floor(h.ts / 3_600_000) === Math.floor(hourStart / 3_600_000), /* MUTANT */',
    why: 'Morning hours read too little sun, afternoon hours too much.',
  },
  {
    id: "2.ii ★★ the live hour reads the preceding hour's value",
    file: AN,
    find: '  const hourEpoch = coveringRadiationEpoch(Math.floor(now / 3_600_000));',
    to: '  const hourEpoch = Math.floor(now / 3_600_000); /* MUTANT */',
    why: 'The live expected PV lags the sun by an hour.',
  },
  {
    id: '2.iii ★★ the solar fit pairs PV with the preceding hour',
    file: AN,
    find: '  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000) - RADIATION_LABEL_LAG_HOURS, wh);',
    to: '  for (const wh of weather.hours) wxByHourEpoch.set(Math.floor(wh.ts / 3_600_000), wh); /* MUTANT */',
    why: 'The posterior μ is fitted on a different pairing than the walk applies it to.',
  },
  {
    id: '2.iv ★ settlement checks the labels of the hours, not the values covering them',
    file: FREEZE,
    find: '    if (!sent.has(coveringRadiationEpoch(Math.floor((dayStartMs + h * HOUR_MS) / HOUR_MS)))) return false;',
    to: '    if (!sent.has(Math.floor((dayStartMs + h * HOUR_MS) / HOUR_MS))) return false; /* MUTANT */',
    why: 'A day freezes without the value for its last hour.',
  },
  {
    id: '3.i ★★★ a measured cloudy hour falls through to μ × 900',
    file: AN,
    find: '  const measured = wh != null && wh.radiationMissing !== true;',
    to: '  const measured = wh != null && wh.radiationMissing !== true && wh.radiationWm2 >= CURTAIL_MIN_GHI_WM2; /* MUTANT */',
    why: 'Dark and cloudy hours are reported as curtailed energy.',
  },
  {
    id: '3.ii ★ a value flagged missing counts as a measurement',
    file: AN,
    find: '  const measured = wh != null && wh.radiationMissing !== true;',
    to: '  const measured = wh != null; /* MUTANT */',
    why: 'An hour the provider did not measure is scored as a dark hour.',
  },
  {
    id: '4.i ★★★ a day freezes whatever the membership',
    file: AN,
    find: '    if (weather && membershipSound && curtailmentDaySettled(weather, hasPosterior, dayStart)) {',
    to: '    if (weather && curtailmentDaySettled(weather, hasPosterior, dayStart)) { /* MUTANT */',
    why: 'A roster glitch at freeze time is written into the day for a week.',
  },
  {
    id: '4.ii ★★ a membership change during the day is ignored',
    file: FREEZE,
    find: "  if (membershipVerdict(o.history, o.dayStartMs, o.dayStartMs + DAY_MS) !== 'stable') return false;",
    to: '  /* MUTANT */',
    why: 'A day walked with an end-of-day roster freezes although its first hours had another.',
  },
  {
    id: '4.iii ★★★ the recorded membership is not compared with the roster',
    file: FREEZE,
    find: "  if (membershipAt(o.history, o.dayStartMs) !== [...o.rosterSns].sort().join(',')) return false;",
    to: '  /* MUTANT */',
    why: 'A Core momentarily missing from the roster freezes a one-Core estimate of a two-Core day.',
  },
  {
    id: '4.iv ★★ a roster Core that reported nothing still passes',
    file: FREEZE,
    find: '    if (!o.walkedSns.includes(sn) || !o.contributedSns.has(sn)) return false;',
    to: '    if (!o.walkedSns.includes(sn)) return false; /* MUTANT */',
    why: 'A day with a dark Core freezes as if the Core had been counted.',
  },
  {
    id: '4.v ★★ old-schema frozen days are kept',
    file: FREEZE,
    find: '    if (raw?.v !== CURTAIL_FREEZE_SCHEMA) { dirty = true; return; }',
    to: '    /* MUTANT */',
    why: 'Days estimated with the preceding-hour pairing and the cloudy-hour heuristic stay for a week.',
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
console.log(`mutate-v1186-2: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
