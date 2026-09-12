#!/usr/bin/env node
/**
 * mutate-push-dwell.mjs — committed mutation harness for v1.143.0's push dwell,
 * observability fixes, and the sticky-clock rebuild.
 *
 * WHY COMMITTED: every one of these is a guard whose correct operation is
 * INDISTINGUISHABLE FROM ITS ABSENCE without a test. A suppressed push looks
 * like no alert. A sweep that logs nothing looks like a sweep that never ran —
 * that is literally why F3 was raised, after ten boots produced zero evidence
 * either way. And a clock silently dropped by an object literal on every 60 s
 * poll is invisible until the one poll where it mattered.
 *
 *   node scripts/mutate-push-dwell.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 * ★ A harness run is only evidence if the BASELINE was green — a red tree kills
 *   every mutant for free (observed for real one release ago).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const REC = resolve(SERVER, 'src/recorder.ts');
const IDX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/pushDwellAndObservability.test.ts', 'test/orphanedNotified.test.ts'];

const MUTANTS = [
  // ── F2: the push dwell ─────────────────────────────────────────────────────
  {
    id: 'i. ★★★ the starvation family loses its push dwell',
    file: MON,
    find: "  if (id.startsWith('msg-rate-floor-')) return Math.max(defaultMs, MSG_RATE_PUSH_DEBOUNCE_MS);",
    to: '  /* MUTANT */',
    why: 'THE DEFECT: 42 of 50 phone pushes in 52.5 h were this one family, 23 of 25 episodes under 30 min, median 9.0 min, every one self-clearing with no operator action available.',
  },
  {
    id: 'ii. the dwell drops below the self-heal window',
    file: MON,
    find: '  process.env.MSG_RATE_PUSH_DEBOUNCE_MS ?? 20 * 60_000,',
    to: '  process.env.MSG_RATE_PUSH_DEBOUNCE_MS ?? 60_000, /* MUTANT */',
    why: 'Below sessionSelfHeal’s own 20-minute starvation trigger the system is still trying to repair itself and the operator has nothing to do.',
  },
  {
    id: 'iii. the dwell overrides a longer caller default',
    file: MON,
    find: "  if (id.startsWith('msg-rate-floor-')) return Math.max(defaultMs, MSG_RATE_PUSH_DEBOUNCE_MS);",
    to: "  if (id.startsWith('msg-rate-floor-')) return MSG_RATE_PUSH_DEBOUNCE_MS; /* MUTANT */",
    why: 'A caller that already demanded a longer hold-down would be silently shortened.',
  },
  {
    id: 'iv. the family prefix widens and swallows other alerts',
    file: MON,
    find: "  if (id.startsWith('msg-rate-floor-')) return",
    to: "  if (id.startsWith('msg-rate')) return", // eslint-disable-line -- MUTANT
    why: 'A 20-minute hold-down leaking onto an unrelated family would delay a real page. The blast radius of this table must stay exact.',
  },
  // ── F3: the sweep must say it ran ──────────────────────────────────────────
  {
    id: 'v. ★ the boot reconcile goes back to logging only when it retires something',
    file: MON,
    find: '      if (!orphanReconcileLogged) {',
    to: '      if (!orphanReconcileLogged && (resolve.length || drop.length)) { /* MUTANT */',
    why: 'A clean sweep and a sweep that never ran become byte-identical — the exact ambiguity that left v1.140.0’s evidence gate unverifiable across ten boots.',
  },
  {
    id: 'vi. the reconcile line stops saying what it examined',
    file: MON,
    find: '`notify: boot reconcile — ${persistedNotified.size} persisted record(s): resolved ${resolve.length}, dropped ${drop.length}, held ${hold.length}`',
    to: "'notify: boot reconcile' /* MUTANT */",
    why: 'A count of zero retirements over zero records is healthy; over forty records it is a detector that has stopped working. The line must distinguish them.',
  },
  // ── F5: the level, not the gate ────────────────────────────────────────────
  {
    // v1.150.0 — REPOINTED, not deleted. The heartbeat became a periodic
    // distribution (the per-minute line was 51.8% of the ring even AT debug,
    // because LOG_LEVEL=debug is standing), so the old anchor text no longer
    // exists. The property this mutant protects — that the line is emitted on
    // the debug channel and not the info logger — did not go away with it.
    id: 'vii. ★ the recorder heartbeat returns to the INFO logger',
    file: REC,
    find: '        debug(\n          `recorder: ${recordedSamplesTotal} samples over ${mins} min`',
    to: '        log(\n          `recorder: ${recordedSamplesTotal} samples over ${mins} min`', // eslint-disable-line -- MUTANT
    why: 'It was debug-GATED but info-EMITTED, so all 3,103 heartbeats carried level 30 and pino could never filter them. 76 of the operator’s 100 default log lines were this one line.',
  },
  {
    id: 'viii. ★ the production bridge stops passing a debug callback',
    file: IDX,
    find: 'const recorder = createRecorder(store, (m) => app.log.info(m), (m) => app.log.debug(m));',
    to: 'const recorder = createRecorder(store, (m) => app.log.info(m)); /* MUTANT */',
    why: 'The default falls back to `log`, so the heartbeat silently returns to INFO with every unit test still green — the wire-it-to-the-production-bridge failure.',
  },
  // ── F4 + the sticky clocks ─────────────────────────────────────────────────
  {
    id: 'ix. the offline observation source stops being recorded',
    file: SNAP,
    find: "        this.snap.devices[d.sn].onlineChangedVia = 'device-list';",
    to: '        /* MUTANT */',
    why: 'Two home Cores went offline in one poll and only one paged, correctly, on a 59-vs-60-second margin — and nothing in the alert said which input started its clock.',
  },
  {
    id: 'x. ★★★ the 60 s rebuild drops the quota clock again',
    file: SNAP,
    find: '        lastQuotaAtMs: existing?.lastQuotaAtMs,',
    to: '        /* MUTANT */',
    why: 'setDeviceList rebuilds the device object every 60 s from an explicit literal. Usually masked by setDeviceQuota re-deriving it microseconds later — NOT masked when the quota fetch then fails, which is exactly when a frozen projection matters.',
  },
  {
    id: 'xi. ★★★ the rebuild drops the cloud-shadow guard',
    file: SNAP,
    find: '        contentStaleSinceMs: existing?.contentStaleSinceMs,',
    to: '        /* MUTANT */',
    why: 'A shadowed panel would lose its guard every 60 s and the alarm path would flap between honest-unknown and a frozen value.',
  },
  {
    id: 'xii. the rebuild drops the v0.97.0 error clock (the pre-existing loss)',
    file: SNAP,
    find: '        lastErrorAt: existing?.lastErrorAt,',
    to: '        /* MUTANT */',
    why: 'This field existed since v0.97.0 for the sole purpose of stopping a REST error resetting the staleness clock, and this literal had been silently discarding it every poll ever since.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-push-dwell: ${MUTANTS.length} mutants\n`);

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
