#!/usr/bin/env node
/**
 * mutate-poll-health-attribution.mjs — committed mutation harness for
 * `pollHealthVerdict` (S1) and the attempt-set plumbing it depends on.
 *
 * WHY COMMITTED: `refreshAll` fetches only `list.filter(d => d.online === 1)`,
 * so `failedSns` can only ever contain devices the poll actually ASKED. Reading
 * absence from it as success meant a cloud-offline SHP2 counted as a healthy
 * poll — `notePollOk()` ran, and because `assessBlind`'s other input counts
 * devices carrying a projection regardless of `online` (and `setDeviceList`
 * PRESERVES projection across the transition) the telemetry-blind CRITICAL
 * returned {blind:false} for the ENTIRE SHP2-dark window. The alarm system
 * stopped watching the alarm path and reported itself healthy. Nothing about
 * that is visible from the outside, so the guard has to be proven.
 *
 * The sibling detector that shared this inference — the v1.88.0 EcoFlow
 * enablement doorbell — was DELETED in v1.139.0 rather than repaired: API error
 * 1006 is a product-class limit, not a grantable account permission, so it could
 * only ever fire falsely. Its mutants are gone with it; a source pin in
 * pollHealthAttribution.test.ts keeps it deleted.
 *
 *   node scripts/mutate-poll-health-attribution.mjs
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
const SNAP = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = ['test/pollHealthAttribution.test.ts', 'test/unreachableDetectors.test.ts'];

const MUTANTS = [
  // ── S1: the poll-health verdict ──────────────────────────────────────
  {
    id: 'i. ★★★ THE LIVE DEFECT: an unpolled SHP2 counts as a healthy poll',
    file: SNAP,
    find: "  const unasked = o.knownShp2Sns.filter((sn) => !attempted.has(sn));\n  if (unasked.length) return { ok: false, reason: 'shp2-not-polled', sns: unasked };",
    to: '  /* MUTANT */',
    why: 'This IS the shipped defect: a cloud-offline SHP2 leaves the telemetry-blind CRITICAL disarmed for the entire dark window, with the system reporting itself healthy.',
  },
  {
    id: 'ii. one healthy panel vouches for a dark one',
    file: SNAP,
    find: '  const unasked = o.knownShp2Sns.filter((sn) => !attempted.has(sn));',
    to: '  const unasked = attempted.size ? [] : [...o.knownShp2Sns]; /* MUTANT */',
    why: 'A partially-dark two-panel fleet reads as healthy — the exact shape v1.129.0 exists to prevent (a second panel dark = its DPUs silently unmonitored).',
  },
  {
    id: 'iii. the asked-and-failed case is dropped',
    file: SNAP,
    find: "  const bad = o.knownShp2Sns.filter((sn) => failed.has(sn));\n  if (bad.length) return { ok: false, reason: 'shp2-fetch-failed', sns: bad };",
    to: '  /* MUTANT */',
    why: 'Reverts v1.86.0 — an SHP2 whose fetch threw would count as OK.',
  },
  {
    id: 'iv. bootstrap fails CLOSED instead of open',
    file: SNAP,
    find: '  if (o.knownShp2Sns.length === 0) return { ok: true }; // bootstrap: nothing known to be dark',
    to: "  if (o.knownShp2Sns.length === 0) return { ok: false, reason: 'shp2-not-polled', sns: [] }; /* MUTANT */",
    why: 'Before the first quota response no projection exists, so every cold boot would assert blindness and raise a CRITICAL.',
  },
  {
    id: 'v. the failed check is inverted',
    file: SNAP,
    find: '  const bad = o.knownShp2Sns.filter((sn) => failed.has(sn));',
    to: '  const bad = o.knownShp2Sns.filter((sn) => !failed.has(sn)); /* MUTANT */',
    why: 'A healthy SHP2 would be reported as failing and a failing one as healthy — the verdict exactly backwards.',
  },
  // ── the production bridge ────────────────────────────────────────
  {
    id: 'vi. ★ the live tick reverts S1 to the failure-set read',
    file: SNAP,
    // v1.140.0 — repointed: R1 reformatted this call site across lines and made
    // the roster an expression. The property is unchanged — alias attemptedSns to
    // the roster and the SHP2 always counts as asked, i.e. the pre-fix behaviour.
    find: '        knownShp2Sns: alarmPathShp2Sns(devicesNow), attemptedSns, failedSns,',
    to: '        knownShp2Sns: alarmPathShp2Sns(devicesNow), attemptedSns: alarmPathShp2Sns(devicesNow), failedSns, /* MUTANT */',
    why: 'pollHealthVerdict would be correct and unreachable — the SHP2 always counted as asked, which is exactly the pre-fix behaviour.',
  },
  {
    id: 'vii. ★ refreshAll reports the whole list as attempted',
    file: SNAP,
    find: '  const attemptedSns = online.map((d) => d.sn);',
    to: '  const attemptedSns = list.map((d) => d.sn); /* MUTANT */',
    why: 'An offline device would be claimed as asked, resurrecting the defect at its source — the one place a single edit re-breaks everything downstream.',
  },
  // ── the deleted doorbell stays deleted ──────────────────────────────
  {
    id: 'viii. ★ the enablement doorbell is reinstated',
    file: SNAP,
    find: '  if (o.knownShp2Sns.length === 0) return { ok: true }; // bootstrap: nothing known to be dark',
    to: '  const failureFirstSeenMs = new Map(); /* MUTANT */\n  if (o.knownShp2Sns.length === 0) return { ok: true }; // bootstrap: nothing known to be dark',
    why: 'The deletion is a DECISION (1006 is product-class, so the detector can only fire falsely), not an accident. Reintroducing its machinery must fail the build.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-poll-recovery-attribution: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
