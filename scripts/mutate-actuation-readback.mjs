#!/usr/bin/env node
/**
 * mutate-actuation-readback.mjs — committed mutation harness for the v1.79.0
 * night-charge apply-readback + grid-loss-abort machinery
 * (server/src/nightChargeActuator.ts, pure decideActuation).
 *
 * WHY COMMITTED: on 2026-08-16 23:55 MST a supervised reserve write was ACK'd
 * by the EcoFlow cloud and never took effect on the SHP2 — the ledger scored a
 * phantom actuation, ~13 kWh of arbitrage was silently forfeited, and nothing
 * in the process ever compared the device's reading to the target. The
 * readback IS the fix; "the tests would catch a regression" must be
 * demonstrable, not asserted (v1.77.0 shipped a gate whose harness passed
 * 8/8 while missing its motivating case).
 *
 *   node scripts/mutate-actuation-readback.mjs
 *
 * ★ Anchor-asserted; mutates in place, restores in finally. Do not touch the
 *   tree while it runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');

const SUBSET = ['test/nightChargeActuator.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the readback branch is dead code — a cloud ACK is an actuation again',
    find: "    if (state.applyVerifiedAtMs == null && state.targetPct != null) {",
    to: "    if (false as boolean && state.applyVerifiedAtMs == null && state.targetPct != null) {",
    why: 'The 08-16 phantom exactly: ACK recorded, device never checked, buy silently forfeited, ledger wrong.',
  },
  {
    id: 'ii. ★ verification inverts — a MISMATCHED device reading stamps "verified"',
    find: "      if (opts.currentReservePct === state.targetPct) return { kind: 'applyVerified' };",
    to: "      if (opts.currentReservePct !== state.targetPct) return { kind: 'applyVerified' };",
    why: 'The phantom write would be "verified" by the very reading that proves it failed.',
  },
  {
    id: 'iii. ★ the grid-loss abort is gone — an outage keeps the artificial 50% floor',
    find: "    if (opts.gridPresent === false && restorable) {",
    to: "    if (false as boolean && restorable) {",
    why: 'A real outage during the charge window escalates runway alarms off a floor the engine itself raised.',
  },
  {
    id: 'iv. the retry cap is ignored — endless re-issues, the operator never hears',
    find: "        if (state.applyRetries < APPLY_MAX_RETRIES &&",
    to: "        if (true &&",
    why: 'Unbounded writes against a device that is not taking them, and applyFailed becomes unreachable.',
  },
  {
    id: 'v. the failure warning repeats every tick instead of once per night',
    find: "        if (!state.applyEscalated) return { kind: 'applyFailed' };",
    to: "        return { kind: 'applyFailed' };",
    why: 'The one-shot escalation contract: a failed night warns once, not sixty times an hour until revert.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', ...(files.length ? ['--', ...files] : [])], {
    cwd: SERVER, stdio: 'pipe',
  });
}

const original = readFileSync(ACT, 'utf8');
let killed = 0;
const survivors = [];

for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    writeFileSync(ACT, original);
    process.exit(2);
  }
  try {
    writeFileSync(ACT, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(ACT, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
