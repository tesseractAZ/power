#!/usr/bin/env node
/**
 * mutate-session-self-heal.mjs — committed harness for the v1.76.0 cloud-session
 * self-heal decision (server/src/sessionSelfHeal.ts).
 *
 * WHY COMMITTED: this module autonomously tears down and rebuilds the MQTT
 * session on a live alarm plant. The guards (multi-device threshold, dwell,
 * cooldown, daily cap) are what keep it from becoming its own flap storm — the
 * 08-08 13:1x presence-flap is the sizing case. Each guard must be demonstrably
 * load-bearing, not decorative.
 *
 *   node scripts/mutate-session-self-heal.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/sessionSelfHeal.ts');
const SUBSET = ['test/sessionSelfHeal.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ single-device transient heals (threshold removed)',
    find: '  if (starvedCount < cfg.minStarvedDevices) {',
    to: '  if (false) { /* MUTANT */',
    why: 'One flaky device would trigger session rebuilds — churn on the healthiest fleet.',
  },
  {
    id: 'ii. onset never resets on recovery (transients accumulate into a heal)',
    find: '    state.starvedSinceMs = null;\n    return { heal: false, reason: `only ${starvedCount} device(s) starved',
    to: '    return { heal: false, reason: `only ${starvedCount} device(s) starved',
    why: 'Disjoint 5-minute blips hours apart would sum to a dwell and rebuild a healthy session.',
  },
  {
    id: 'iii. dwell removed (heals on the first starved tick)',
    find: '  if (starvedFor < cfg.starvedForMs) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A compressor-cycle transient would trigger an immediate rebuild.',
  },
  {
    id: 'iv. ★ cooldown removed (the healer becomes the flap storm)',
    find: '  if (state.lastHealMs != null && nowMs - state.lastHealMs < cfg.cooldownMs) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A persistent cloud outage would rebuild the session every dwell interval forever.',
  },
  {
    id: 'v. daily cap removed',
    find: '  if (state.healsToday >= cfg.maxPerDay) {',
    to: '  if (false) { /* MUTANT */',
    why: 'The bounded-blast-radius promise (max 6/day) silently evaporates.',
  },
  {
    id: 'vi. ★ onset NOT reset after healing (immediate re-heal at cooldown expiry)',
    find: '  state.starvedSinceMs = null;\n  return {\n    heal: true,',
    to: '  return {\n    heal: true,',
    why: 'The rebuild never gets its own dwell to prove itself; heals chain at exactly cooldown period.',
  },
  {
    id: 'vii. day counter never resets (healer permanently dead after 6 heals ever)',
    find: '  if (state.dayKey !== day) {\n    state.dayKey = day;\n    state.healsToday = 0;\n  }',
    to: '  state.dayKey = day; /* MUTANT */',
    why: 'After the first bad week the self-heal would be silently disabled for the lifetime of the process.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }
const original = readFileSync(MOD, 'utf8');
let killed = 0; const survivors = [];
console.log(`mutate-session-self-heal: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
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
