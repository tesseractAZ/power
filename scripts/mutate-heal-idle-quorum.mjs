#!/usr/bin/env node
/**
 * mutate-heal-idle-quorum.mjs — committed mutation harness for the v1.157.0 self-heal
 * quorum membership rule (server/src/sessionSelfHeal.ts `selfHealQuorum`, wired in
 * server/src/index.ts's rate-floor tick).
 *
 * WHY COMMITTED: the heal budget is shared by every device and is the only route to
 * rebuilding the session under the alarm-path panel. On 2026-09-13 three Cores whose
 * collapses surfaced while discharging went idle at reserve, stayed held (an idle Core
 * cannot clear the recovery bar), and kept a quorum that spent four heals on a healthy
 * session. Each mutant restores that defect or breaks what the fix must keep: the panel's
 * identity exception, heals for active hardware, and an alert set nobody filtered.
 *
 *   node scripts/mutate-heal-idle-quorum.mjs
 *
 * ★ Every anchor is pre-flighted before any test runs; a red subset baseline aborts, and
 *   the full-suite fallback is baselined (once, lazily) before it may count a kill.
 * ★ A test run that could not START (spawn or buffer failure) aborts — it is never
 *   counted as a kill.
 * ★ Mutates the working tree in place and restores it in a finally block; SIGINT/SIGTERM/
 *   SIGHUP restore and exit. It refuses to start if a target already carries a mutant
 *   marker. Do not run git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const HEAL = resolve(SERVER, 'src/sessionSelfHeal.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/selfHealIdleQuorum.test.ts',
  'test/sessionSelfHeal.test.ts',
  'test/rosterAwareSpares.test.ts',
];

const MUTANTS = [
  // ── the membership rule ───────────────────────────────────────────────────
  {
    id: 'i. ★★★ every surfaced collapse votes again (the 09-13 defect)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (true /* MUTANT */) counted.push(member);',
    why: 'Idle Cores held at reserve refill the quorum hourly and spend the budget the panel needs.',
  },
  {
    id: 'ii. ★★ the panel is idle-filtered like any Core (identity guard dropped)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (!idleSns.has(c.sn) /* MUTANT */) counted.push(member);',
    why: 'The alarm chain\'s input loses its heal vote the day its projection gains power fields that read idle.',
  },
  {
    id: 'iii. ★★ only the panel ever counts (overcorrection)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (alarmPathSns.has(c.sn) /* MUTANT */) counted.push(member);',
    why: 'A genuine session wedge on Cores that are moving power could never be healed.',
  },
  {
    id: 'iv. ★ the count ignores the filter',
    file: HEAL,
    find: '  return { count: counted.length, counted, idleExcluded };',
    to: '  return { count: surfaced.length /* MUTANT */, counted, idleExcluded };',
    why: 'The log names the right voters while the decision still counts the idle ones.',
  },
  {
    id: 'v. ★★ the panel exception is removed from the heal decision',
    file: HEAL,
    find: '  const quorumMet = starvedCount >= cfg.minStarvedDevices || opts?.alarmCriticalStarved === true;',
    to: '  const quorumMet = starvedCount >= cfg.minStarvedDevices; /* MUTANT */',
    why: 'With idle Cores no longer voting, a panel-only wedge (09-14 21:22) can never start the heal clock.',
  },
  // ── the production wiring ─────────────────────────────────────────────────
  {
    id: 'vi. ★★★ the tick passes every surfaced collapse again',
    file: INDEX,
    find: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved },',
    to: '      now, collapses.length /* MUTANT */, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved },',
    why: 'selfHealQuorum is computed, logged and ignored; production burns the budget exactly as before.',
  },
  {
    id: 'vii. ★★ idle membership is never recorded',
    file: INDEX,
    find: '        if (idle) idleSurfacedSns.add(sn);',
    to: '        /* MUTANT: idle add deleted */',
    why: 'The idle set is always empty, so every held Core votes.',
  },
  {
    id: 'viii. ★ every surfaced device is recorded as idle',
    file: INDEX,
    find: '        if (idle) idleSurfacedSns.add(sn);',
    to: '        idleSurfacedSns.add(sn); /* MUTANT */',
    why: 'Only the panel can ever start a heal; an active Core wedge is abandoned.',
  },
  {
    id: 'ix. ★★ the idle filter leaks into the ALERT set',
    file: INDEX,
    find: '      if (dec.surfaced) {\n        surfacedCollapses.add(sn);',
    to: '      if (dec.surfaced && !idle) { /* MUTANT */\n        surfacedCollapses.add(sn);',
    why: 'Held collapses silently resolve when a Core idles and re-page when it wakes — the v1.111.0 flap, reintroduced.',
  },
  {
    id: 'x. the alarm-path exception reads the filtered set',
    file: INDEX,
    find: '    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn));',
    to: '    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn) && !idleSurfacedSns.has(c.sn)); /* MUTANT */',
    why: 'The panel exception starts depending on the panel\'s power data instead of its identity.',
  },
  {
    id: 'xi. the idle exclusion is logged every tick',
    file: INDEX,
    find: '      if (!healIdleExcluded.has(m.sn)) {',
    to: '      if (true) { /* MUTANT */',
    why: 'Three idle Cores write ~1,800 identical lines a night and bury the heal trail.',
  },
  {
    id: 'xii. the exclusion edge never re-arms',
    file: INDEX,
    find: '      if (!healQuorum.idleExcluded.some((m) => m.sn === sn)) healIdleExcluded.delete(sn);',
    to: '      /* MUTANT: edge never re-armed */',
    why: 'After the first night a device\'s later exclusions are never logged, so the absence of a line proves nothing.',
  },
  {
    id: 'xiii. heals stop naming their voters',
    file: INDEX,
    find: "      app.log.warn(`self-heal: ${healVerdict.reason} [counted: ${healQuorum.counted.map((m) => m.deviceName).join(', ')}]`);",
    to: '      app.log.warn(`self-heal: ${healVerdict.reason}`); /* MUTANT */',
    why: 'Which devices drove a rebuild has to be reconstructed from collapse and recovery lines again.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    // A numeric exit with no signal is a test failure. A signal-killed run or a spawn
    // failure is NOT, and must never be counted as a kill.
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
    console.error(`\nABORT: ${f} already contains a mutant marker — an earlier run was interrupted or another harness is running. Restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restoreAll();
    console.error(`\ninterrupted (${sig}) — tree restored, run not counted`);
    process.exit(130);
  });
}

for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
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
console.log(`mutate-heal-idle-quorum: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot be used to count a kill.');
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
