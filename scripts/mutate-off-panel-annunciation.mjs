#!/usr/bin/env node
/**
 * mutate-off-panel-annunciation.mjs — committed harness for the v1.95.0
 * off-panel annunciation demotion (server/src/alertMonitor.ts).
 *
 * WHY COMMITTED: this code SILENCES ALARMS on a life-safety plant. Every guard
 * is what stands between "stop chiming about bench hardware" and "went quiet
 * during a real emergency":
 *   - the hysteresis (a flickering isConnect must never silence a home Core)
 *   - the instant re-arm (asymmetry must favour making noise)
 *   - the empty-roster bail-out (an unreadable panel must demote nobody)
 *   - the thermal-critical carve-out (an overheating bench pack must still page)
 *
 *   node scripts/mutate-off-panel-annunciation.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/alertMonitor.ts');
const SUBSET = ['test/offPanelAnnunciation.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ hysteresis removed — one missed roster tick silences a live home Core',
    find: '    if (n >= ticks) out.push(d.sn);',
    to: '    out.push(d.sn); /* MUTANT */',
    why: 'A single isConnect flicker would demote a home Core mid-emergency.',
  },
  {
    id: 'ii. ★ re-arm removed — a Core sighted again stays demoted',
    find: "    if (connectedSns.has(d.sn)) { streak.delete(d.sn); continue; }",
    to: "    if (connectedSns.has(d.sn)) { continue; } /* MUTANT */",
    why: 'The streak would never reset, so a transient absence silences the device permanently.',
  },
  {
    id: 'iii. ★ empty-roster bail-out removed — an unreadable panel demotes the whole fleet',
    find: '  if (connectedSns.size === 0) { streak.clear(); return []; }',
    to: '  if (false) { streak.clear(); return []; } /* MUTANT */',
    why: 'When the SHP2 goes cloud-dark the roster is empty, so EVERY DPU would be silenced at once.',
  },
  {
    id: 'iv. ★ thermal-critical carve-out removed — an overheating bench pack goes silent',
    find: "  if (alert.severity === 'critical' && alert.category === 'Thermal') return false;",
    to: '  /* MUTANT */',
    why: 'A lithium pack overheating on the bench is precisely the case that must page regardless of wiring.',
  },
  {
    id: 'v. non-DPU devices demoted too (the SHP2 could silence itself)',
    find: "    if (d.projection?.kind !== 'dpu') continue;\n    if (connectedSns.has(d.sn)) { streak.delete(d.sn); continue; }",
    to: "    if (connectedSns.has(d.sn)) { streak.delete(d.sn); continue; } /* MUTANT */",
    why: 'The SHP2 is never in its own DPU roster, so it would demote itself every tick.',
  },
  {
    id: 'vi. muted-SN match dropped — demotes every alert regardless of device',
    find: '  return mutedSns.some((sn) => alert.id.includes(sn));',
    to: '  return true; /* MUTANT */',
    why: 'Fleet-wide and home-device alerts would all stop annunciating.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }
const original = readFileSync(MOD, 'utf8');
let killed = 0; const survivors = [];
console.log(`mutate-off-panel-annunciation: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    writeFileSync(MOD, original); process.exit(2);
  }
  try {
    writeFileSync(MOD, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally { writeFileSync(MOD, original); }
}
console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) { for (const s of survivors) console.log(`  - ${s.id}`); process.exit(1); }
console.log('post-run: tree restored');
