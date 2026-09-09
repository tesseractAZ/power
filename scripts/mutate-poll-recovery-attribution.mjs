#!/usr/bin/env node
/**
 * mutate-poll-recovery-attribution.mjs — committed mutation harness for
 * v1.138.0's recovery attribution (the doorbell) and poll-health verdict (S1).
 *
 * WHY COMMITTED: the defect this replaces PRODUCED A FALSE STATEMENT OF FACT on
 * the operator's phone about a life-safety system, and left no trace that
 * anything was wrong. `failedSns` is built only from devices the poll actually
 * ASKED (`list.filter(d => d.online === 1)`), and two call sites read absence
 * from it as success. On 2026-09-08 15:52:31 MST, BACC - Delta 3 Plus went
 * cloud-OFFLINE and 302 ms later — same tick, same /device/list payload — the
 * panel pushed "EcoFlow data restored — quota data is flowing again". That SN's
 * lastUpdated was 0 then and is 0 now: no quota fetch has ever succeeded for it.
 *
 * The same inference sat fifteen lines below, applied to the SHP2 — the single
 * alarm-path device — where it disarmed the telemetry-blind CRITICAL for the
 * whole cloud-offline window (S1).
 *
 *   node scripts/mutate-poll-recovery-attribution.mjs
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

const SUBSET = ['test/pollRecoveryAttribution.test.ts', 'test/unreachableDetectors.test.ts'];

const MUTANTS = [
  // ── the doorbell ───────────────────────────────────────────────────────────
  {
    id: 'i. ★★★ THE LIVE DEFECT: never-asked counts as recovered',
    file: SNAP,
    find: '    if (!attempted.has(sn)) continue;  // ★ NEVER ASKED — hold, do not judge',
    to: '    /* MUTANT */',
    why: 'This IS the shipped defect. A device going OFFLINE produces an "EcoFlow data restored" push to the phone. Observed live twice in a 50 h window.',
  },
  {
    id: 'ii. the attempted test is inverted',
    file: SNAP,
    find: '    if (!attempted.has(sn)) continue;',
    to: '    if (attempted.has(sn)) continue; /* MUTANT */',
    why: 'Only never-asked devices would ring, and every genuine recovery would be silent — the detector exactly backwards.',
  },
  {
    id: 'iii. ★ the held entry is deleted anyway (the false-NEGATIVE half)',
    file: SNAP,
    find: '    if (!attempted.has(sn)) continue;  // ★ NEVER ASKED — hold, do not judge',
    to: '    if (!attempted.has(sn)) { o.tenureMs.delete(sn); continue; } /* MUTANT */',
    why: 'Restores the old clock-reset. Re-arms the doorbell after every flap, AND silences a genuine enablement that lands during an offline window — the device returns succeeding and never re-accrues 30 min.',
  },
  {
    id: 'iv. the still-failing guard is dropped',
    file: SNAP,
    find: '    if (failed.has(sn)) continue;      // still failing — clock runs on',
    to: '    /* MUTANT */',
    why: 'A device failing continuously would be announced as recovered on the first poll past its own tenure gate.',
  },
  {
    id: 'v. the tenure gate is removed',
    file: SNAP,
    find: '    if (o.nowMs - since >= minTenure) recovered.push(sn);',
    to: '    recovered.push(sn); /* MUTANT */',
    why: 'Every transient one-poll blip pushes an enablement claim; the 30-minute gate is the only thing making the signal rare enough to mean anything.',
  },
  {
    id: 'vi. the tenure boundary flips to strict',
    file: SNAP,
    find: '    if (o.nowMs - since >= minTenure) recovered.push(sn);',
    to: '    if (o.nowMs - since > minTenure) recovered.push(sn); /* MUTANT */',
    why: 'Off-by-one against the >= convention the sibling slowMs detector uses.',
  },
  {
    id: 'vii. a fired entry is not retired',
    file: SNAP,
    find: '    if (o.nowMs - since >= minTenure) recovered.push(sn);\n    o.tenureMs.delete(sn);',
    to: '    if (o.nowMs - since >= minTenure) recovered.push(sn); /* MUTANT */',
    why: 'The same recovery would re-announce on every subsequent poll — a push storm from one event.',
  },
  {
    id: 'viii. the clock is restarted on every failing poll',
    file: SNAP,
    find: '  for (const sn of o.failedSns) if (!o.tenureMs.has(sn)) o.tenureMs.set(sn, o.nowMs);',
    to: '  for (const sn of o.failedSns) o.tenureMs.set(sn, o.nowMs); /* MUTANT */',
    why: 'Tenure could never accrue past one poll interval, so the doorbell could never legitimately ring at all.',
  },
  // ── S1: the poll-health verdict ────────────────────────────────────────────
  {
    id: 'ix. ★★★ S1: an unpolled SHP2 counts as a healthy poll',
    file: SNAP,
    find: "  const unasked = o.knownShp2Sns.filter((sn) => !attempted.has(sn));\n  if (unasked.length) return { ok: false, reason: 'shp2-not-polled', sns: unasked };",
    to: '  /* MUTANT */',
    why: 'This IS the S1 defect: a cloud-offline SHP2 leaves the telemetry-blind CRITICAL disarmed for the entire dark window — the alarm system silently stops watching the alarm path.',
  },
  {
    id: 'x. S1: one healthy panel vouches for a dark one',
    file: SNAP,
    find: '  const unasked = o.knownShp2Sns.filter((sn) => !attempted.has(sn));',
    to: '  const unasked = attempted.size ? [] : [...o.knownShp2Sns]; /* MUTANT */',
    why: 'A partially-dark two-panel fleet reads as healthy — the exact shape v1.129.0 exists to prevent (a second panel dark = its DPUs silently unmonitored).',
  },
  {
    id: 'xi. S1: the asked-and-failed case is dropped',
    file: SNAP,
    find: "  const bad = o.knownShp2Sns.filter((sn) => failed.has(sn));\n  if (bad.length) return { ok: false, reason: 'shp2-fetch-failed', sns: bad };",
    to: '  /* MUTANT */',
    why: 'Reverts v1.86.0 — an SHP2 whose fetch threw would count as OK.',
  },
  {
    id: 'xii. S1: bootstrap fails CLOSED instead of open',
    file: SNAP,
    find: '  if (o.knownShp2Sns.length === 0) return { ok: true }; // bootstrap: nothing known to be dark',
    to: "  if (o.knownShp2Sns.length === 0) return { ok: false, reason: 'shp2-not-polled', sns: [] }; /* MUTANT */",
    why: 'Before the first quota response no projection exists, so every cold boot would assert blindness and raise a CRITICAL.',
  },
  // ── the production bridge ──────────────────────────────────────────────────
  {
    id: 'xiii. ★ the live tick stops passing the attempt set',
    file: SNAP,
    find: '        nowMs: Date.now(), tenureMs: failureFirstSeenMs, attemptedSns, failedSns,',
    to: '        nowMs: Date.now(), tenureMs: failureFirstSeenMs, attemptedSns: failedSns, failedSns, /* MUTANT */',
    why: 'The extracted function stays correct while the REAL poll loop is inert — every recovery silenced. This is the wire-it-to-the-production-bridge failure mode.',
  },
  {
    id: 'xiv. ★ the live tick reverts S1 to the failure-set read',
    file: SNAP,
    find: '      const health = pollHealthVerdict({ knownShp2Sns, attemptedSns, failedSns });',
    to: '      const health = pollHealthVerdict({ knownShp2Sns, attemptedSns: knownShp2Sns, failedSns }); /* MUTANT */',
    why: 'pollHealthVerdict would be correct and unreachable — the SHP2 always counted as asked, which is exactly the pre-fix behaviour.',
  },
  {
    id: 'xv. refreshAll reports the whole list as attempted',
    file: SNAP,
    find: '  const attemptedSns = online.map((d) => d.sn);',
    to: '  const attemptedSns = list.map((d) => d.sn); /* MUTANT */',
    why: 'An offline device would be claimed as asked, resurrecting BOTH defects at their source — the one place a single edit re-breaks everything downstream.',
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
