#!/usr/bin/env node
/**
 * mutate-device-ceiling.mjs — committed harness for the reserve write envelope and
 * the partial-actuation adoption (server/src/nightChargeActuator.ts).
 *
 * WHY COMMITTED: v1.161.0 raised RESERVE_WRITE_MAX_PCT from 50 to 90 on the owner's
 * instruction, because the old bound called itself the device's documented limit in
 * four places and cited no document. ★★★ The night of 2026-09-16 SETTLED it: the
 * write went out as 90, the cloud accepted it without error, and the SHP2 moved
 * 16 -> 50 and stopped. The bound was right; it just had no evidence. v1.164.0 put
 * it back at 50, and mutant iv now guards the proven value in the other direction.
 *
 * The outcome v1.161.0 made reachable is REAL and still guarded: the panel takes the
 * write, raises its reserve, and settles BELOW what was asked.
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
    id: 'iv. ★★ the envelope is widened past what the device accepts',
    file: ACT,
    find: 'export const RESERVE_WRITE_MAX_PCT = 50;',
    to: 'export const RESERVE_WRITE_MAX_PCT = 90; /* MUTANT */',
    why: 'Proven live on 2026-09-16: the SHP2 takes a 90 write and settles at 50. Asking for more buys nothing and costs two false notifications a night — the 21:30 announcement promises a reserve the panel will not hold, and settingsDrift reads our own clamped write as an EXTERNAL change.',
  },
  // v1.162.0 — the envelope guards must move TOGETHER. v1.161.0 raised the ceiling but left
  // four bare [10,50] pairs behind; the apply guard and `restorable` are the dangerous two.
  {
    id: 'v. ★★★ `restorable` stops tracking the envelope constant (STRANDS the reserve)',
    file: ACT,
    find: '      state.priorReservePct >= RESERVE_WRITE_MIN_PCT &&\n      state.priorReservePct <= RESERVE_WRITE_MAX_PCT;',
    to: '      state.priorReservePct >= 10 && state.priorReservePct <= 30; /* MUTANT */',
    why: 'The apply raises FROM a 40% floor, captures priorReservePct 40, and then the revert refuses it forever: the panel holds a raised reserve indefinitely, the house runs on grid every day, and the ledger records a clean completed night. This is the expensive end state the module exists to prevent.',
  },
  {
    id: 'vi. ★★ the apply sanity bound stops tracking the envelope constant',
    file: ACT,
    find: '  if (cur == null || !Number.isInteger(cur)\n      || cur < RESERVE_WRITE_MIN_PCT || cur > RESERVE_WRITE_MAX_PCT) return { kind: \'none\' };',
    to: '  if (cur == null || !Number.isInteger(cur) || cur < 10 || cur > 30) return { kind: \'none\' }; /* MUTANT */',
    why: 'A reserve sitting anywhere above the mutated bound makes the nightly apply return {kind:"none"} SILENTLY — no log, no alert, no buy — and the operator has no way to see why the night did nothing.',
  },
  {
    id: 'vii. ★★ the adoption baseline stops tracking the envelope constant',
    file: ACT,
    find: '    state.attemptBaselinePct >= RESERVE_WRITE_MIN_PCT &&\n    state.attemptBaselinePct <= RESERVE_WRITE_MAX_PCT',
    to: '    state.attemptBaselinePct >= 10 && state.attemptBaselinePct <= 30 /* MUTANT */',
    why: 'A lost-confirmation write from a baseline above the mutated bound is never adopted, so a reserve the device DID raise is orphaned — the revert target is lost with it.',
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
