#!/usr/bin/env node
/**
 * mutate-charge-now.mjs — committed mutation harness for the v1.84.0 Charge
 * Now responder (server/src/chargeNowResponder.ts, pure decision core).
 *
 * WHY COMMITTED: this module WRITES to a device in response to an inference
 * chain. Every rail that keeps it bounded — the storm hold, the episode
 * latch, the daily cap, the readback loop — fails SILENT-DANGEROUS: without
 * them it fights the operator, writes unbounded, or trusts a cloud ACK the
 * way the night-charge actuator did on 2026-08-16.
 *
 *   node scripts/mutate-charge-now.mjs
 *
 * ★ Anchor-asserted; mutates in place, restores in finally.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/chargeNowResponder.ts');

const SUBSET = ['test/chargeNowResponder.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the storm hold is gone — the responder overrides a pre-storm pre-charge',
    find: "  if (i.stormPrepActive) {",
    to: "  if (false as boolean) {",
    why: 'An operator deliberately buying on-peak ahead of a storm would have force-charge silently turned off under them.',
  },
  {
    id: 'ii. ★★ the episode latch is gone — it responds every tick of a continuous episode',
    find: "  if (state.episodeLatched) return { kind: 'none' };",
    to: "  /* MUTANT */",
    why: 'A standing episode would push/write every 60 seconds until the condition cleared.',
  },
  {
    id: 'iii. ★★ the daily cap is gone — unbounded writes against a determined operator',
    find: "  if (state.actionsToday >= CHARGE_NOW_DAILY_CAP) {",
    to: "  if (false as boolean) {",
    why: 'The operator re-enabling Charge Now on purpose would be fought forever, two writes per episode.',
  },
  {
    id: 'iv. ★ readback success inverts — still-ON verifies as OFF',
    find: "    if (i.slots != null && pv.slots.every((n) => !(i.slots!.find((s) => s.slot === n)?.on))) {",
    to: "    if (i.slots != null) {",
    why: 'The v1.79.0 phantom, reborn: a write that never took effect would be declared verified.',
  },
  {
    id: 'v. ★ advisory mode writes — the default configuration is no longer read-only',
    find: "  if (i.mode === 'advisory') {\n    state.episodeLatched = true;\n    return { kind: 'advise', on: named };\n  }",
    to: "  /* MUTANT */",
    why: 'Every installation on the default option would start issuing device writes.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', ...(files.length ? ['--', ...files] : [])], {
    cwd: SERVER, stdio: 'pipe',
  });
}

const original = readFileSync(MOD, 'utf8');
let killed = 0;
const survivors = [];

for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    writeFileSync(MOD, original);
    process.exit(2);
  }
  try {
    writeFileSync(MOD, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(MOD, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
