#!/usr/bin/env node
/**
 * mutate-resolve-evidence.mjs — committed mutation harness for the v1.75.0
 * falling-edge evidence gate (server/src/alertMonitor.ts pure helpers).
 *
 * WHY COMMITTED: on 2026-08-08 a cloud presence flap emitted false "Resolved:"
 * pushes for the STANDING Core 3 err533 battery-protection critical. The gate is
 * what stops a data gap from impersonating a recovery, so "the tests would catch
 * a regression" has to be demonstrable rather than asserted.
 *
 * Mutant `iv` is the one that matters most: exempting NOTHING looks safer
 * ("gate everything!") but silently freezes the starvation family's resolve on
 * the very signal it measures — msg-rate recoveries would never resolve during
 * REST staleness, recreating stuck-card churn from the opposite direction.
 *
 *   node scripts/mutate-resolve-evidence.mjs
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
const MON = resolve(SERVER, 'src/alertMonitor.ts');

const SUBSET = ['test/alertResolveEvidence.test.ts', 'test/orphanedNotified.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ the freeze decision always says "not frozen" (the gate becomes a no-op)',
    find: '  const sn = alertSourceSn(p.id, p.deviceSns);\n  if (sn == null) return false;',
    to: '  return false; /* MUTANT */\n  const sn = alertSourceSn(p.id, p.deviceSns);\n  if (sn == null) return false;',
    why: 'Everything still LOOKS wired, but a flap resolves standing criticals exactly as on 08-08.',
  },
  {
    id: 'ii. staleness comparison inverted (fresh freezes, stale resolves)',
    find: '  return dev != null && Number.isFinite(dev.lastUpdated) && nowMs - (dev.lastUpdated as number) < staleMs;',
    to: '  return dev != null && Number.isFinite(dev.lastUpdated) && nowMs - (dev.lastUpdated as number) >= staleMs; /* MUTANT */',
    why: 'The gate would freeze healthy resolves and wave through flap-driven ones — worse than no gate.',
  },
  {
    id: 'iii. a vanished device counts as fresh evidence',
    find: '  return dev != null && Number.isFinite(dev.lastUpdated)',
    to: '  return true || dev != null && Number.isFinite(dev.lastUpdated)',
    why: 'A device dropped from the map entirely (the deepest flap) would resolve all its alerts.',
  },
  {
    id: 'iv. ★ the exempt list is emptied (starvation alerts gated on their own gating signal)',
    find: "  return id.startsWith('offline-') || id.startsWith('msg-rate-floor-') || id.startsWith('zombie-');",
    to: '  return false; /* MUTANT */',
    why: 'msg-rate recoveries could never resolve while REST is stale — stuck cards from the opposite direction.',
  },
  {
    id: 'v. system alerts (no SN) treated as frozen',
    find: '  if (sn == null) return false;',
    to: '  if (sn == null) return true; /* MUTANT */',
    why: 'telemetry-blind could never resolve while devices are absent — absence IS its recovery.',
  },
  {
    id: 'vi. SN matching accepts trivial substrings',
    find: '  for (const sn of deviceSns) if (sn.length >= 8 && id.includes(sn)) return sn;',
    to: '  for (const sn of deviceSns) if (id.includes(sn)) return sn; /* MUTANT */',
    why: 'A degenerate roster key could bind unrelated alerts to the wrong device’s freshness.',
  },
  {
    id: 'vii. ★ msg-rate-floor orphans resolve-push again at boot',
    find: "    if (id.startsWith('msg-rate-floor-')) { drop.push(id); continue; }",
    to: '    /* MUTANT */',
    why: 'Restart during a starvation would once again announce "Resolved: barely reporting" at 2 msg/min.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const original = readFileSync(MON, 'utf8');
let killed = 0;
const survivors = [];
console.log(`mutate-resolve-evidence: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    writeFileSync(MON, original);
    process.exit(2);
  }
  try {
    writeFileSync(MON, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(MON, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
