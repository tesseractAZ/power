#!/usr/bin/env node
/**
 * mutate-audit-fixes-0920.mjs — committed harness for the four confirmed findings of the
 * 2026-09-20 log audit (index.ts evening job, ecoflow/rest.ts, snapshot.ts, alertMonitor.ts).
 *
 * WHY COMMITTED: each rail is one guard wide and each failure is SILENT — a write that
 * fires against tonight's own decision, a false "resolved" on the warranty pack, a push
 * that reaches the owner on no channel at all. Every one of them was observed live.
 *
 *   node scripts/mutate-audit-fixes-0920.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const IDX = resolve(SERVER, 'src/index.ts');
const REST = resolve(SERVER, 'src/ecoflow/rest.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');

const SUBSET = ['test/auditFixes0920.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a prior night’s ARM outlives tonight’s HOLD',
    file: IDX,
    find: "    if (shape !== 'charge') {\n      cancelStalePriorArm(today, nowMs, shape === 'hold'",
    to: "    if (false) { /* MUTANT */\n      cancelStalePriorArm(today, nowMs, shape === 'hold'",
    why: 'Saturday’s arm writes at Sunday 23:55 against the engine’s fresh decision not to charge — reserve to 50% and a force-charge riding it.',
  },
  {
    id: 'ii. ★★ the config-suppressed HOLD path skips the cancel',
    file: IDX,
    find: "      cancelStalePriorArm(today, nowMs, 'tonight the engine decided to HOLD (no buy needed)');\n      // Suppressed by owner config",
    to: "      // MUTANT\n      // Suppressed by owner config",
    why: 'With NIGHT_CHARGE_NOTIFY_ON_HOLD=false the job returns before the general cancel — the exact path the 2026-09-20 audit found open.',
  },
  {
    id: 'iii. ★★★ an APPLIED write is cleared as if it were a stale arm',
    file: IDX,
    find: '  if (s.appliedAtMs != null || s.applyAttemptedAtMs != null) return false;',
    to: '  /* MUTANT */',
    why: 'The record that knows to REVERT a raised reserve is thrown away — the panel holds the 50% floor into the on-peak with nothing left to restore it.',
  },
  {
    id: 'iv. ★★★ a code-0 reply with no payload is passed through',
    file: REST,
    find: "  if (method !== 'PUT' && parsed.data == null) {",
    to: '  if (false) { /* MUTANT */',
    why: 'undefined reaches the projector as a TypeError naming a BMS field — a vendor empty-success reads as five Cores failing at once.',
  },
  {
    id: 'v. ★★★ an empty quota replaces the cached one',
    file: SNAP,
    find: '    if (raw == null || Object.keys(raw).length === 0) return;',
    to: '    /* MUTANT */',
    why: 'Every pack alert evaluates against packs: [] and RESOLVES — the false "Resolved: Pack confirmed defective" push of 2026-09-20 09:06.',
  },
  {
    id: 'vi. ★★★ a failed push is dropped again',
    file: AM,
    find: "        if (outcome === 'failed') {",
    to: "        if (false) { /* MUTANT */",
    why: 'A short-lived High alert whose one push attempt fails reaches the owner on no channel at all — overnight the phone is the only channel.',
  },
  {
    id: 'vii. \u2605\u2605\u2605 a WRITE with no data is treated as a failure again',
    file: REST,
    find: "  if (method !== 'PUT' && parsed.data == null) {",
    to: '  if (parsed.data == null) { /* MUTANT */',
    why: 'Every panel write is reported FAILED although it took effect \u2014 the 2026-09-21 false "reserve stuck at 50%" CRITICAL, and tomorrow\u2019s arming refused behind it.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
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
console.log(`mutate-audit-fixes-0920: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
