#!/usr/bin/env node
/**
 * mutate-device-ceiling.mjs — committed harness for the v1.161.0 raised write
 * envelope and the partial-actuation adoption (server/src/nightChargeActuator.ts).
 *
 * WHY COMMITTED: raising RESERVE_WRITE_MAX_PCT from 50 to 90 (owner's
 * instruction, 2026-09-16) made a new outcome reachable — the SHP2 accepts the
 * write, raises its reserve, and settles BELOW what was asked. Whether the panel
 * enforces a ceiling of its own is UNVERIFIED: the old bound described itself as
 * the device's documented limit in four places and cited no document, and no
 * vendor source on disk mentions backupReserveSoc at all.
 *
 * `deviceCeilingPct` is what makes that question safe to leave open. Without it
 * a short readback is indistinguishable from the 2026-08-16 phantom (a write the
 * cloud ACK'd and the device ignored): both retries burn, the night ends on
 * applyFailed, and the operator is PAGED that "tonight's buy is forfeited" with
 * the ledger corrected to actuated:0 — while the panel is holding a raised
 * reserve and charging. The distinction it draws is one comparison wide, so a
 * plausible edit to either bound silently restores the false page.
 *
 *   node scripts/mutate-device-ceiling.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block
 *   and on SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');

const SUBSET = ['test/nightChargeActuator.test.ts', 'test/reserveFloorPosture.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a short readback goes back to the retry ladder (false "buy forfeited")',
    file: ACT,
    find: "        const achieved = deviceCeilingPct(state, opts.currentReservePct);\n        if (achieved != null) return { kind: 'applyCeiling', achievedPct: achieved };",
    to: '        /* MUTANT */',
    why: 'A panel that grants 50 of a 90 ask burns both retries and then pages the operator that the night was forfeited, correcting the ledger to actuated:0 — while the reserve IS raised and the buy IS happening.',
  },
  {
    id: 'ii. ★★★ the phantom write is adopted as a ceiling',
    file: ACT,
    find: '  if (liveReservePct <= attemptBaselinePct) return null; // never moved — the phantom write',
    to: '  if (liveReservePct < attemptBaselinePct) return null; /* MUTANT */',
    why: 'The 2026-08-16 case — cloud ACK, device ignored it, reserve unchanged — would be stamped VERIFIED at the baseline, so a night that never actuated is scored as one that did. This is the defect v1.79.0 exists to catch.',
  },
  {
    id: 'iii. ★★ an overshoot is treated as a ceiling',
    file: ACT,
    find: '  if (liveReservePct >= targetPct) return null;          // took it in full (or overshot)',
    to: '  if (liveReservePct > targetPct) return null; /* MUTANT */',
    why: 'A device that took the write in full would be adopted as a partial actuation and rewrite its own target — the plain applyVerified path would never be reached.',
  },
  {
    id: 'iv. ★★ the owner-chosen ceiling is reverted to 50',
    file: ACT,
    find: 'export const RESERVE_WRITE_MAX_PCT = 90;',
    to: 'export const RESERVE_WRITE_MAX_PCT = 50; /* MUTANT */',
    why: 'ARB_COST_MAX_SOC_PCT=90 goes back to being inert: the engine asks for a 100% setpoint and silently writes 50, which is the state the owner instructed be changed.',
  },
];

function passes(cmd, args) {
  try { execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' }); return true; }
  catch (e) { if (typeof e?.status === 'number' && e?.signal == null) return false; throw e; }
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
console.log(`mutate-device-ceiling: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
