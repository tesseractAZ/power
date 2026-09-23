#!/usr/bin/env node
/**
 * mutate-presence-fresh-readback.mjs — committed harness for v1.179.0: the grid resolver's
 * PRESENCE term (computeShp2GridConnected, server/src/gridState.ts) needs a fresh readback.
 *
 * WHY COMMITTED: the failure is silent and in the missed-alarm direction. A stale "Grid OK"
 * re-exposed by an OFFLINE→ONLINE /status flip, or left standing by a quota fetch that keeps
 * failing, asserts grid presence: the runway audible is gated, SoC crossings are spoken as
 * "drawing from grid power", off_grid publishes OFF. Nothing errors.
 *
 *   node scripts/mutate-presence-fresh-readback.mjs
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
const GRID = resolve(SERVER, 'src/gridState.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const REST = resolve(SERVER, 'src/ecoflow/rest.ts');

const SUBSET = [
  'test/presenceFreshReadback.test.ts', 'test/gridState.test.ts', 'test/shp2Shadow.test.ts',
  'test/gridMeasuredAbsentVeto.test.ts', 'test/poolCoverageGate.test.ts',
];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 presence is gated on online + shadow only again (no look at the reading\u2019s age)',
    file: GRID,
    find: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs)) return null;',
    to: '  if (!shp2 || !shp2.online || shp2.contentStaleSinceMs != null) return null; /* MUTANT */',
    why: 'A /status flip re-exposes the pre-offline "Grid OK", and a failing quota leaves it standing indefinitely: the runway audible is gated through an outage.',
  },
  {
    id: 'ii. \u2605\u2605\u2605 presence is not gated at all',
    file: GRID,
    find: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs)) return null;',
    to: '  if (!shp2) return null; /* MUTANT */',
    why: 'An offline or cloud-replayed panel\u2019s frozen "Grid OK" asserts presence into an outage.',
  },
  {
    id: 'iii. \u2605\u2605 a private, looser readback window (1 h) instead of the shared SHP2_READBACK_STALE_MS',
    file: GRID,
    find: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs)) return null;',
    to: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs, 3_600_000)) return null; /* MUTANT */',
    why: 'A failing quota keeps a stale "1" asserting presence for an hour; the control readbacks and the alarm drift apart.',
  },
  {
    id: 'iv. \u2605\u2605 the resolver ignores its injected clock',
    file: GRID,
    find: '  const nowMs = input.nowMs ?? Date.now();',
    to: '  const nowMs = 0; /* MUTANT */',
    why: 'A clock of 0 makes every reading look fresh: the gate is present and inert.',
  },
  {
    id: 'v. \u2605 a 6 s /status blip drops a reading that is still fresh',
    file: GRID,
    find: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs)) return null;',
    to: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs) || (shp2.onlineChangedAtMs ?? 0) > (shp2.lastQuotaAtMs ?? 0)) return null; /* MUTANT */',
    why: 'Every blip at the floor removes the gridSta backstop between charge bursts for a poll: the false at-floor critical v0.89.0 closed, spoken during the nightly force-charge.',
  },
  {
    id: 'vi. \u2605\u2605\u2605 the panel\u2019s frozen gridWatt proves the grid again (online + shadow gate only)',
    file: GRID,
    find: '  if (!shp2 || !shp2ReadbackFresh(shp2, nowMs)) return 0;',
    to: '  if (!shp2 || !shp2.online || shp2.contentStaleSinceMs != null) return 0; /* MUTANT */',
    why: 'A 7.8 kW sample frozen mid-charge keeps importLive true \u2014 exempt from both floor guards \u2014 and mutes an at-floor outage outright.',
  },
  {
    id: 'vii. \u2605\u2605 a Core\u2019s frozen ac_in proves the grid again',
    file: GRID,
    find: '    .filter((d) => d.online && sourceSns.has(d.sn) && coreContentFresh(d, nowMs))',
    to: '    .filter((d) => d.online && sourceSns.has(d.sn)) /* MUTANT */',
    why: 'A Core listed online with its telemetry stopped keeps a frozen acIn asserting importLive through an outage.',
  },
  {
    id: 'viii. \u2605\u2605 "nothing can be heard" collapses to "the grid is gone" again',
    file: GRID,
    find: '  const presenceUnknown = !present && !absenceEvidence;',
    to: '  const presenceUnknown = false; /* MUTANT */',
    why: 'A stale panel mid-window aborts the night\u2019s buy and switches force-charge OFF for the night on no evidence.',
  },
  {
    id: 'ix. \u2605 the declared-grid veto is not counted as evidence of absence',
    file: GRID,
    find: '  const absenceEvidence = gridMeasuredAbsent || shp2GridConnected === false || (entityUsable && entityPresent === false);',
    to: '  const absenceEvidence = shp2GridConnected === false || (entityUsable && entityPresent === false); /* MUTANT */',
    why: 'An outage held by the veto on a now-silent panel reads as merely unknown: the night-charge keeps buying from a grid that is gone.',
  },
  {
    id: 'x. \u2605\u2605 force-charge gets the boolean collapse again',
    file: IDX,
    find: '    gridPresent: gridNow.present ? true : gridNow.presenceUnknown ? null : false,\n    // Connected is gridSta === 1 ONLY',
    to: "    gridPresent: typeof gridNow.present === 'boolean' ? gridNow.present : null, /* MUTANT */\n    // Connected is gridSta === 1 ONLY",
    why: 'An unknown grid switches force-charge OFF for the night.',
  },
  {
    id: 'xi. \u2605\u2605 the REST request is unbounded again (undici\u2019s 300 s = the readback window)',
    file: REST,
    find: '    headersTimeout: ECOFLOW_REST_TIMEOUT_MS, bodyTimeout: ECOFLOW_REST_TIMEOUT_MS,',
    to: '    /* MUTANT */',
    why: 'One hung request holds the serial poll for 300 s and ages the panel\u2019s reading out of the window: presence lapses on a healthy grid.',
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
console.log(`mutate-presence-fresh-readback: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
