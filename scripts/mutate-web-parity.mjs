#!/usr/bin/env node
/**
 * mutate-web-parity.mjs — committed mutation harness for v1.146.0's web/server
 * membership parity and the fleet ratio gates.
 *
 * WHY COMMITTED: `web/src/shp2Membership.ts` is a hand-maintained literal copy of
 * the server module, and its own header has demanded lock-step since v0.9.75.
 * That demand FAILED THREE TIMES — it was three server revisions behind when
 * found, taking only the first panel where the server had unioned across every
 * panel since v1.129.0, so with a second SHP2 present half the plant silently
 * vanished from the fleet totals a human reads. A comment is not a mechanism.
 *
 * The ratio gates are the same shape one layer down: numerator and denominator
 * filtered independently, so a partly-unreported pack renders as degradation.
 *
 *   node scripts/mutate-web-parity.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ A harness run is only evidence if the BASELINE was green — confirm `0 fail`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const WEBMEM = resolve(REPO, 'web/src/shp2Membership.ts');
const THERM = resolve(REPO, 'web/src/pages/ThermalPanel.tsx');
const DEGCARD = resolve(REPO, 'web/src/cards/DegradationCard.tsx');
const SESS = resolve(SERVER, 'src/telnet/session.ts');

const SUBSET = ['test/webServerMembershipParity.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the web mirror drifts back to a single `find`',
    file: WEBMEM,
    find: "  const out = new Set<string>();\n  for (const d of Object.values(devices)) {\n    if (d.projection?.kind !== 'shp2') continue;",
    to: "  const out = new Set<string>();\n  for (const d of Object.values(devices).filter((x) => x.projection?.kind === 'shp2').slice(0, 1)) { /* MUTANT */",
    why: 'THE DRIFT: with a second SHP2 present every DPU wired to it falls out of the connected set and is dropped from EnergyFlow’s fleet totals and ThermalPanel — half the plant, silently, on the screen a human reads.',
  },
  {
    id: 'ii. the mirror stops guarding a missing sources subtree',
    file: WEBMEM,
    find: '    for (const s of (d.projection as Shp2Projection).sources ?? []) {',
    to: '    for (const s of (d.projection as Shp2Projection).sources) { /* MUTANT */',
    why: 'A partial /quota can return the backup SoC while omitting pd303_mc sources; the server guards the same way and the UI would throw instead of degrading.',
  },
  {
    id: 'iii. the mirror stops requiring isConnected',
    file: WEBMEM,
    find: '      if (s.isConnected && s.sn) out.add(s.sn);',
    to: '      if (s.sn) out.add(s.sn); /* MUTANT */',
    why: 'A DPU listed on the panel but not actually wired in would count toward home-pool figures.',
  },
  {
    id: 'iv. the empty-set fallback inverts',
    file: WEBMEM,
    find: '  if (connected.size === 0) return true;',
    to: '  if (connected.size === 0) return false; /* MUTANT */',
    why: 'A plant with no panel — or one whose /quota has not hydrated — would have its ENTIRE fleet filtered out of every total.',
  },
  // ── the ratio gates ────────────────────────────────────────────────────────
  {
    id: 'v. ★ the pool degradation ratio un-pairs its populations',
    file: THERM,
    find: '      if (pk.fullCapMah != null && pk.designCapMah != null) {\n        fullMah += pk.fullCapMah;\n        designMah += pk.designCapMah;\n      }',
    to: '      if (pk.fullCapMah != null) fullMah += pk.fullCapMah;\n      if (pk.designCapMah != null) designMah += pk.designCapMah; /* MUTANT */',
    why: 'A pack reporting design but not current capacity inflates the denominator alone, so a partly-unreported pool renders degradation that does not exist.',
  },
  {
    id: 'vi. ★ the fleet capacity ratio un-pairs its populations',
    file: DEGCARD,
    find: '  const capNow = sumDefined(capPairs.map((p) => p.currentCapacityKwh));\n  const capDesign = sumDefined(capPairs.map((p) => p.designCapacityKwh));',
    to: '  const capNow = sumDefined(deg.packs.map((p) => p.currentCapacityKwh));\n  const capDesign = sumDefined(deg.packs.map((p) => p.designCapacityKwh)); /* MUTANT */',
    why: 'Same defect on the fleet card: sumDefined filters each side independently.',
  },
  {
    id: 'vii. an absent degradation report is stamped with the current time again',
    file: SESS,
    find: 'degradation: d.degradation() ?? { generatedAt: 0,',
    to: 'degradation: d.degradation() ?? { generatedAt: Date.now(), /* MUTANT */',
    why: 'An ABSENT report becomes indistinguishable from one computed this instant. Inert today, which is exactly why it would be believed the first time something read it.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-web-parity: ${MUTANTS.length} mutants\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    for (const [f, s] of originals) writeFileSync(f, s);
    process.exit(2);
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
