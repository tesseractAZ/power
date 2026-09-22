#!/usr/bin/env node
/**
 * mutate-pack-identity.mjs — committed harness for v1.173.0: per-pack alert state follows the
 * BATTERY, not the slot (server/src/alertMonitor.ts, alerts.ts, analytics.ts).
 *
 * WHY COMMITTED: after a pack is replaced or the Core renumbers its slots (Core 4,
 * 2026-09-20), each of these rails keeps one battery's state from being read as another's —
 * a swallowed first push, an onset spanning two batteries, an inherited warn-hold.
 *
 *   node scripts/mutate-pack-identity.mjs
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AL = resolve(SERVER, 'src/alerts.ts');
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/packIdentityRenumber.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a missing serial counts as a pack change',
    file: AM,
    find: '    if (before != null && after != null && before !== after) out.push({ id: a.id, from: before, to: after });',
    to: '    if (before !== after) out.push({ id: a.id, from: String(before), to: String(after) }); /* MUTANT */',
    why: 'A serial that drops out for one read closes every live pack episode and re-pages it.',
  },
  {
    id: 'ii. ★★★ the old pack’s push record survives the replacement',
    file: AM,
    find: '      if (persistedNotified.delete(c.id)) persistNotified();',
    to: '      /* MUTANT */',
    why: 'The new pack’s alert re-tracks as already notified — its first push (critical included) is swallowed.',
  },
  {
    id: 'iii. ★★ the onset is not restarted for the new pack',
    file: AM,
    find: '      restampAlertOnset(c.id, now);',
    to: '      /* MUTANT */',
    why: 'The new episode’s cleared record spans two batteries — the RMA evidence trail v1.102.0 protects.',
  },
  {
    id: 'iv. ★★★ the warn-hold is inherited by the pack that moves in',
    file: AL,
    find: '        if (heldBy != null && pk.packSn && heldBy !== pk.packSn) heldVdiffWarnKeys.delete(vdiffKey);',
    to: '        /* MUTANT */',
    why: 'A healthy pack moving into slot 1 fires vdiff-warn at 20-23 mV without ever crossing the 24 mV rise line.',
  },
  {
    id: 'v. ★★ the baseline alerts carry no pack serial',
    file: AN,
    find: '      ...(t.packSn ? { sourcePackSn: t.packSn } : {}),',
    to: '      /* MUTANT */',
    why: 'The residency check cannot see a renumber under a baseline alert — one episode silently describes two batteries.',
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
console.log(`mutate-pack-identity: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
