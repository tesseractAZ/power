#!/usr/bin/env node
/**
 * mutate-dark-core.mjs — committed mutation harness for the v1.150.0 dark-core
 * cluster.
 *
 * WHY COMMITTED: the defect these guards replace produced NO SIGNAL OF ANY KIND
 * for nine days. Core 2 recorded zero samples of every metric from 2026-08-11 to
 * 2026-08-19 — a third of the wired fleet — and the telemetry-gap detector wrote
 * nothing, because it sets `sawHomeInsert` on ANY non-bench home SN and Cores 1
 * and 3 kept writing. No log line, no alert, no gap record.
 *
 * It surfaced six weeks later only as a second-order effect: fleet PV sums taken
 * across that window returned ~32% of true production, the phantom "forecast
 * misses" saturated the PV band calibrator, and the night-charge basis gate
 * closed. The system's own answer to "is telemetry healthy?" was yes throughout.
 *
 * A guard against a failure that emits nothing cannot be trusted to prose. Each
 * mutant below restores one part of the pre-v1.150.0 blindness.
 *
 *   node scripts/mutate-dark-core.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const RECORDER = resolve(SERVER, 'src/recorder.ts');
const ANALYTICS = resolve(SERVER, 'src/analytics.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/darkCoreCoverage.test.ts', 'test/pushDwellAndObservability.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the per-device staleness sweep is deleted (the shipped blindness)',
    file: RECORDER,
    find: '      for (const [sn, lastMs] of lastInsertBySn) {',
    to: '      for (const [sn, lastMs] of []) { /* MUTANT */',
    why: 'THIS IS THE DEFECT: a single core can go dark for nine days and the recorder writes no gap record, because the fleet clock is reset by any surviving core.',
  },
  {
    id: 'ii. ★ the sweep reports a gap but never names the SN',
    file: RECORDER,
    find: '          recordTelemetryGap(lastMs, now, { sn });',
    to: '          recordTelemetryGap(lastMs, now); /* MUTANT */',
    why: 'A per-device blackout would be filed as a FLEET gap — claiming no home device reported, while home samples were arriving the whole time.',
  },
  {
    id: 'iii. the per-device gap re-reports on every batch',
    file: RECORDER,
    find: '          perDeviceGapOpen.add(sn);',
    to: '          /* MUTANT */',
    why: 'One nine-day blackout would emit a record per insert batch — thousands of rows, evicting the real history from a capped sidecar.',
  },
  {
    id: 'iv. a bench spare is treated as a dark core',
    file: RECORDER,
    find: '        if (isBenchSpareSn(sn)) continue;            // a bench spare is dark BY DESIGN',
    to: '        /* MUTANT */',
    why: 'Every bench spare would raise a permanent telemetry-gap alarm, and the real signal would be buried in known-good noise.',
  },
  {
    id: 'v. ★ an all-skipped day goes back to reporting covered:true',
    file: ANALYTICS,
    find: '    if (presentBySn.size > 0 && evaluated === 0) covered = false;',
    to: '    /* MUTANT */',
    why: 'A day with full daylight and NOT ONE evaluated core reads as covered, with worstSn/worstFrac null so the row carries no hint — absence read as success.',
  },
  {
    id: 'vi. the evaluated counter stops counting',
    file: ANALYTICS,
    find: '      evaluated++;',
    to: '      /* MUTANT */',
    why: 'Equivalent to deleting the guard: evaluated stays 0 on every day, so EVERY day with any SN present is force-marked uncovered — the v1.94.0 regression that emptied the skill window.',
  },
  {
    id: 'vii. ★ the durable ledger PV sum loses its coverage gate',
    file: INDEX,
    find: '    actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE ? round2(pvWh / 1000) : null;',
    to: '    actualPvKwh = round2(pvWh / 1000); /* MUTANT */',
    why: 'A deflated fleet sum is written PERMANENTLY into the never-pruned ledger, feeding readiness band coverage and the HARD under-buy safety criterion. A bad ledger row does not age out.',
  },
  {
    id: 'viii. ★ per-core coverage is averaged instead of minimised',
    file: INDEX,
    find: '      worstCov = Math.min(worstCov, coverageFrac(pts, fcSpanStart, fcSpanEnd));',
    to: '      worstCov = (worstCov + coverageFrac(pts, fcSpanStart, fcSpanEnd)) / 2; /* MUTANT */',
    why: 'One dark core in three averages to a healthy-looking 0.67 while the total is a third short — the exact arithmetic that let this episode through.',
  },
  {
    id: 'xiii. ★ the ANALYZE bound is removed (the 9,725 ms boot freeze returns)',
    file: RECORDER,
    find: '    db.exec(`PRAGMA analysis_limit=400;`);',
    to: '    /* MUTANT */',
    why: 'Restores a MEASURED 9,725 ms of a 9,726 ms boot window during which the add-on has no HTTP listener, no MQTT ingest, no poll and no alarm evaluation.',
  },
  {
    // The bound must land AFTER ANALYZE for this mutant to mean anything. The
    // first draft replaced the try-block in place, which left the pragma
    // textually BEFORE ANALYZE — it survived because it never actually tested
    // the ordering it was named for. Mutate the ANALYZE site instead.
    id: 'xiv. the bound is set AFTER analyze, so it does nothing',
    file: RECORDER,
    find: '    db.exec(`ANALYZE samples;`);',
    to: '    db.exec(`ANALYZE samples;`); db.exec(`PRAGMA analysis_limit=400;`); /* MUTANT */',
    why: 'The pragma is per-connection and binds only a LATER ANALYZE; running it afterwards is inert and the scan is unbounded again, while the code still reads as fixed.',
  },
  {
    id: 'x. ★ the per-device gap clocks stop being seeded at boot (the v1.150.0 blindness)',
    file: RECORDER,
    find: '        lastInsertBySn.set(r.sn, Number(r.maxTs));',
    to: '        /* MUTANT */',
    why: 'Restores the shipped defect: a device already dark at boot never enters the Map the sweep iterates, so a blackout spanning a restart is invisible — and this add-on booted ELEVEN times in 48 h.',
  },
  {
    id: 'xi. ★ a failed seed becomes silent',
    file: RECORDER,
    find: "      log(`recorder: per-device gap clock seeding FAILED",
    to: "      void 0; (() => `recorder: per-device gap clock seeding FAILED", // eslint-disable-line -- MUTANT
    why: 'An unseeded sweep looks EXACTLY like a working one; without the line, v1.150.0 blindness returns with no trace at all.',
  },
  {
    id: 'xii. the seed stops excluding synthetic SNs and bench spares',
    file: RECORDER,
    find: '        `SELECT sn, MAX(ts) AS maxTs FROM samples WHERE sn NOT IN (${restartGapExcludedSns.map(() => \'?\').join(\',\')}) GROUP BY sn`,',
    to: '        `SELECT sn, MAX(ts) AS maxTs FROM samples GROUP BY sn`, /* MUTANT */',
    why: 'Bench spares are dark BY DESIGN and synthetic SNs are off-cadence; sweeping them raises a permanent false gap that buries the real signal.',
  },
  {
    id: 'ix. the recorder heartbeat returns to a line per minute',
    file: RECORDER,
    find: '      if (recordedSamplesWindows >= SAMPLE_SUMMARY_EVERY) {',
    to: '      if (recordedSamplesWindows >= 1) { /* MUTANT */',
    why: 'Restores ~59.4 lines/hour — 51.8% of the log ring and roughly half the visible incident window, on a channel the deployment does not filter.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-dark-core: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    for (const [f, s] of originals) writeFileSync(f, s);
    process.exit(2);
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
