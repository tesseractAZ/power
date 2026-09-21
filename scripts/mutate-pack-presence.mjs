#!/usr/bin/env node
/**
 * mutate-pack-presence.mjs — committed harness for the v1.172.0 ghost-pack-slot rule
 * (server/src/packPresence.ts, wired in server/src/snapshot.ts).
 *
 * WHY COMMITTED: hiding a pack is a life-safety decision in both directions. Too eager and
 * a live pack vanishes from the alarms; too timid and a pulled pack's frozen readings feed
 * alerts, the recorder and analytics forever (Core 4, 2026-09-20). Each rail is one
 * comparison wide.
 *
 *   node scripts/mutate-pack-presence.mjs
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
const PP = resolve(SERVER, 'src/packPresence.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = ['test/packPresence.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the count rule hides without the Core giving a positive count',
    file: PP,
    find: '  if (packCount != null && Number.isInteger(packCount) && packCount >= 1 && packs.length > packCount) {',
    to: '  if (packs.length > (packCount ?? 0)) { /* MUTANT */',
    why: 'A transient bpNum of 0 (the reconnect-zero trap) or a missing one hides live packs from every alarm.',
  },
  {
    id: 'ii. ★★★ a slot is hidden without being clearly behind the others',
    file: PP,
    find: '      if (keptFloor - since(c) >= PACK_STALE_MS) hideSet.set(c.num, c);',
    to: '      if (true) hideSet.set(c.num, c); /* MUTANT */',
    why: 'Right after a restart every slot is first-seen at once; a quiet night then hides a live pack at random.',
  },
  {
    id: 'iii. ★★ a repeated serial hides a slot that is still MOVING',
    file: PP,
    find: '      if (newest - since(g) >= PACK_STALE_MS) hideSet.set(g.num, g);',
    to: '      if (true) hideSet.set(g.num, g); /* MUTANT */',
    why: 'Two live slots that report one serial (a vendor glitch) lose one of them from every alarm.',
  },
  {
    id: 'iv. ★★★ the repeated-serial rule is removed',
    file: PP,
    find: '    if (group.length < 2) continue;',
    to: '    continue; /* MUTANT */',
    why: 'With no pack count, a renumbered pack’s old slot lingers forever at frozen readings.',
  },
  {
    id: 'v. ★★★ the REST refresh path skips the rule',
    file: SNAP,
    find: '    cur.projection = projectByProduct(cur.productName, raw);\n    this.hidePhantomPacks(sn, cur);',
    to: '    cur.projection = projectByProduct(cur.productName, raw); /* MUTANT */',
    why: 'Every five-minute REST refresh brings the ghost slot back until the next MQTT delta.',
  },
  {
    id: 'vi. ★★★ the MQTT merge path skips the rule',
    file: SNAP,
    find: '    cur.projection = projectByProduct(cur.productName, merged);\n    this.hidePhantomPacks(sn, cur);',
    to: '    cur.projection = projectByProduct(cur.productName, merged); /* MUTANT */',
    why: 'The ~1 Hz MQTT deltas re-project with the ghost slot — the panel flickers it back every second.',
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
console.log(`mutate-pack-presence: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
