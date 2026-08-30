#!/usr/bin/env node
/**
 * mutate-reserve-posture.mjs — the below-reserve severity discriminator.
 *
 * WHY COMMITTED: this decides whether a pool at/below the reserve floor PAGES
 * the operator or sits silently on screen. Its failure modes are both silent
 * and opposite: key it wrong and either a genuine breach of a raised owner
 * floor goes unpushed (2026-08-28, the reason this exists), or every night's
 * charge window pages at 23:00 until the operator mutes the channel.
 *
 *   node scripts/mutate-reserve-posture.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');
const SUBSET = ['test/reserveFloorPosture.test.ts', 'test/ownerFloorAttribution.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the retired magic-number proxy returns (raised owner floor goes silent)',
    file: ALERTS,
    find: "          severity: onGrid ? (arbitrageRaised ? 'info' : 'warning') : 'critical',",
    to: "          severity: onGrid ? (reserve <= 15 ? 'warning' : 'info') : 'critical', /* MUTANT */",
    why: 'A genuine breach of the 20% owner floor drops to silent info — exactly the regression this release prevents.',
  },
  {
    id: 'ii. ★ arbitrage window pages every night (F14 contract broken)',
    file: ALERTS,
    find: "          severity: onGrid ? (arbitrageRaised ? 'info' : 'warning') : 'critical',",
    to: "          severity: onGrid ? 'warning' : 'critical', /* MUTANT */",
    why: 'The charge window filling the pool pushes [Medium] nightly — the noise the F14 contract exists to prevent.',
  },
  {
    id: 'iii. ★ off-grid loses its critical',
    file: ALERTS,
    find: "          severity: onGrid ? (arbitrageRaised ? 'info' : 'warning') : 'critical',",
    to: "          severity: arbitrageRaised ? 'info' : 'warning', /* MUTANT */",
    why: 'A real outage at the reserve floor stops being an emergency.',
  },
  {
    id: 'iv. push priority dropped from a genuine breach',
    file: ALERTS,
    find: "          ...(onGrid && !arbitrageRaised ? { priority: 'medium' as const } : {}),",
    to: '          /* MUTANT */',
    why: 'The breach is visible but never pushes — the 08-05 #3 defect restored.',
  },
  {
    id: 'v. ★ posture predicate ignores the revert (reserve looks raised forever)',
    file: ACT,
    find: '  return state.appliedAtMs != null && state.revertedAtMs == null;',
    to: '  return state.appliedAtMs != null; /* MUTANT */',
    why: 'After the first night-charge ever, every future floor breach is classified as arbitrage and never pages again.',
  },
  {
    id: 'vi. posture predicate always false',
    file: ACT,
    find: '  return state.appliedAtMs != null && state.revertedAtMs == null;',
    to: '  return false; /* MUTANT */',
    why: 'The nightly charge window pages as a floor breach.',
  },
  {
    id: 'vii. \u2605 runway alarm reads the DEVICE reserve again (nightly phantom AT-RESERVE-FLOOR)',
    file: ACT,
    find: '  if (isReserveArbitrageRaised(state)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'ownerReserveFloorPct returns the actuator\u2019s own 50% instruction, so the runway alarm reports AT RESERVE FLOOR for the whole charge window every night.',
  },
  {
    id: 'viii. owner floor trusts an out-of-envelope prior',
    file: ACT,
    find: '    if (prior != null && Number.isInteger(prior) && prior >= 10 && prior <= 50) return prior;',
    to: '    if (prior != null) return prior; /* MUTANT */',
    why: 'A corrupt persisted prior becomes the floor every consumer measures against.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }
const originals = new Map([[ALERTS, readFileSync(ALERTS, 'utf8')], [ACT, readFileSync(ACT, 'utf8')]]);
const restore = () => { for (const [f, s] of originals) writeFileSync(f, s); };

let killed = 0; const survivors = [];
console.log(`mutate-reserve-posture: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const hits = original.split(m.find).length - 1;
    if (hits !== 1) {
      console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
      restore(); process.exit(2);
    }
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           -> ${m.why}`); }
    restore();
  }
} finally { restore(); }

console.log(`\nmutate-reserve-posture: ${killed}/${MUTANTS.length} killed`);
if (survivors.length) { console.log('\nSURVIVORS:'); for (const s of survivors) console.log(`  - ${s.id}`); process.exit(1); }
