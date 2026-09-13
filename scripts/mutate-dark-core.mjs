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

const SUBSET = ['test/darkCoreCoverage.test.ts', 'test/seedAndBootPhases.test.ts', 'test/pushDwellAndObservability.test.ts'];

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
    find: '          recordTelemetryGap(lastMs, Math.max(now, lastMs + darkMs), { sn });',
    to: '          recordTelemetryGap(lastMs, Math.max(now, lastMs + darkMs)); /* MUTANT */',
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
    find: '      lastInsertBySn.set(sn, lastTs);',
    to: '        /* MUTANT */',
    why: 'Restores the shipped defect: a device already dark at boot never enters the Map the sweep iterates, so a blackout spanning a restart is invisible — and this add-on booted ELEVEN times in 48 h.',
  },
  {
    id: 'xi. ★ a failed seed becomes silent',
    file: RECORDER,
    find: "    log(`recorder: per-device gap clock seeding FAILED",
    to: "    void 0; (() => `recorder: per-device gap clock seeding FAILED", // eslint-disable-line -- MUTANT
    why: 'An unseeded sweep looks EXACTLY like a working one; without the line, v1.150.0 blindness returns with no trace at all.',
  },
  {
    id: 'xii. ★ synthetic SNs are seeded (and so swept)',
    file: RECORDER,
    find: '      if (SYNTHETIC_SNS.has(sn)) continue;            // off-cadence by design; never swept',
    to: '      /* MUTANT */',
    why: 'The forecast archive and night-charge overlay write off-cadence by design; seeded, each is ledgered as a dark device after 6 h.',
  },
  {
    id: 'xv. ★★ the seed skips the stale bench list again (Core 5 dropped)',
    file: RECORDER,
    find: '      lastInsertBySn.set(sn, lastTs);',
    to: '      if (benchSpareSns().includes(sn)) continue; lastInsertBySn.set(sn, lastTs); /* MUTANT */',
    why: 'THE v1.152.0 DEFECT: before the roster is published, benchSpareSns() is the stale SPARE_DPU_SNS literal, which excluded Core 5 — a wired home Core whose blackout across a restart then goes unrecorded.',
  },
  {
    id: 'xvi. ★★ the outage guard is removed (every device dark after a >6 h outage)',
    file: RECORDER,
    find: '        const darkMs = seededNotYetWritten.has(sn)',
    to: '        const darkMs = false /* MUTANT */ && seededNotYetWritten.has(sn)',
    why: 'After any add-on outage over 6 h every device is ledgered as a per-device blackout on the first sweep — the fleet was dark, not the devices.',
  },
  {
    id: 'xvii. the pre-outage term measures to the wall clock instead of the fleet anchor',
    file: RECORDER,
    find: '  const span = fleetAnchorMs == null ? 0 : Math.max(0, fleetAnchorMs - seedMs);',
    to: '  const span = Math.max(0, Date.now() - seedMs); /* MUTANT */',
    why: "Charges the add-on's own downtime to every device again: the guard in name only.",
  },
  {
    id: 'xviii. ★ a write does not move a device off its seeded clock',
    file: RECORDER,
    find: '        seededNotYetWritten.delete(s.sn); // v1.154.0 — its clock is in-process now, not seeded',
    to: '        /* MUTANT */',
    why: "A device that reported after boot and then went quiet is measured from the process's first home write instead of its own — a false gap for a device silent under 6 h.",
  },
  {
    id: 'xix. the post-boot clock restarts on every batch',
    file: RECORDER,
    find: '      if (firstHomeInsertMono < 0) firstHomeInsertMono = performance.now();',
    to: '      firstHomeInsertMono = performance.now(); /* MUTANT */',
    why: 'A device dark since boot accrues no in-process dark time, so a blackout that begins at a restart is never recorded.',
  },
  {
    id: 'xx. the seed takes one metric per SN instead of the newest across all',
    file: RECORDER,
    find: '        if (ts > lastTs) lastTs = ts;',
    to: '        if (lastTs === 0) lastTs = ts; /* MUTANT */',
    why: 'A device is seeded from an old, rarely written metric and filed as dark while its other series are current.',
  },
  {
    id: 'xxi. a clock-skewed boot writes a gap that ends before it starts',
    file: RECORDER,
    find: '          recordTelemetryGap(lastMs, Math.max(now, lastMs + darkMs), { sn });',
    to: '          recordTelemetryGap(lastMs, now, { sn }); /* MUTANT */',
    why: 'On an RTC-less Pi booting behind its newest sample, the ledger gains a negative-duration record.',
  },
  {
    id: 'xxii. ★ the boot-phases line is emitted before the seed again',
    file: RECORDER,
    find: '  // (v1.154.0 — the boot-phases line is emitted at the END of createRecorder.)',
    to: '  log(`recorder: boot phases — ${tOpen}, ${tSchema}, ${tAnalyze} (total 0ms)`); /* MUTANT */',
    why: 'THE v1.153.0 ERROR: a per-phase line that stops short of the seed turned a 62.6% phase into "99.99%".',
  },
  {
    id: 'xxiii. ★ a second boot-phases line is emitted before the end',
    file: RECORDER,
    find: "  const tProbe = phase('restart-probe');",
    to: "  const tProbe = phase('restart-probe'); log(`recorder: boot phases — ${tOpen}, ${tSchema}, ${tAnalyze}, ${tSetup}, ${tSeed}, ${tProbe}, rest 0ms (total 0ms, db ${dbPath})`); /* MUTANT */",
    why: 'The first line a reader finds stops short of the call — the shape of the v1.153.0 "99.99%" error, with the real line still present further down.',
  },
  {
    id: 'xxiv. ★ work runs after the boot-phases line',
    file: RECORDER,
    find: '\n\n  return {\n    insertSnapshot: (snap) => record(extract(snap)),',
    to: '\n  for (let i = 0; i < 1; i++) void i; /* MUTANT: work after the phases line */\n\n  return {\n    insertSnapshot: (snap) => record(extract(snap)),',
    why: 'Anything placed between the line and the return blocks boot outside the measurement, and the phases still sum to the total the line reports.',
  },
  {
    id: 'xxv. ★★ earlier fleet-dark windows are not subtracted (an intervening boot defeats the guard)',
    file: RECORDER,
    find: '  const beforeOutage = fleetAnchorMs == null ? 0 : Math.max(0, span - fleetDarkOverlapMs(fleetDarkWindows, seedMs, fleetAnchorMs));',
    to: '  const beforeOutage = span; /* MUTANT */',
    why: 'A few-minute boot in which other devices wrote moves the anchor past a ten-hour outage, and the next boot files a silent device as dark for all of it.',
  },
  {
    id: 'xxvi. the sweep passes no fleet-dark windows',
    file: RECORDER,
    find: '          ? seededDeviceDarkMs(lastMs, bootFleetAnchorMs, performance.now() - firstHomeInsertMono, fleetDark)',
    to: '          ? seededDeviceDarkMs(lastMs, bootFleetAnchorMs, performance.now() - firstHomeInsertMono) /* MUTANT */',
    why: 'The pure function is right and the production call ignores it.',
  },
  {
    id: "xxvii. ★ a device's own per-device gaps are discounted as if the fleet were dark",
    file: RECORDER,
    find: '      const fleetDark = telemetryGapsLog.filter((g) => g.sn == null);',
    to: '      const fleetDark = telemetryGapsLog.slice(); /* MUTANT */',
    why: 'A Core already recorded as dark subtracts its OWN blackout, drops under the threshold, and its record stops being extended across restarts.',
  },
  {
    id: 'xxviii. the window union is computed over unsorted windows',
    file: RECORDER,
    find: '    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)\n    .sort((a, b) => a[0] - b[0]);',
    to: '    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s); /* MUTANT: unsorted */',
    why: 'The ledger is append-ordered with in-place extensions; an unsorted merge drops windows and under-subtracts.',
  },
  {
    id: 'xxix. ★ a seed statement becomes a full index scan',
    file: RECORDER,
    find: "  firstSn: 'SELECT MIN(sn) AS v FROM samples INDEXED BY idx_samples_sn_metric_ts',",
    to: "  firstSn: 'SELECT DISTINCT sn AS v FROM samples', /* MUTANT */",
    why: 'The 5.8 s boot stall returns with every behavioural test green, because the test database has a handful of rows.',
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
