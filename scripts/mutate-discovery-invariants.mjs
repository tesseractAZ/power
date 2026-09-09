#!/usr/bin/env node
/**
 * mutate-discovery-invariants.mjs — committed mutation harness for v1.137.0's
 * discovery-table audit (B3) and every-connect re-assertion (B5).
 *
 * WHY COMMITTED: both defects are SILENT BY CONSTRUCTION. An incoherent
 * (device_class, state_class, unit) triple publishes successfully, retains
 * successfully, and then either drops the entity with one log line or compiles
 * the wrong statistic — the add-on cannot tell the difference from its side. A
 * broker that loses its retained store looks identical to a healthy one from
 * here too: the connection succeeds, the publishes succeed, and the entities
 * are simply gone in HA. Neither leaves a trace to alert on, so the guards
 * themselves have to be proven.
 *
 *   node scripts/mutate-discovery-invariants.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const DISC = resolve(SERVER, 'src/mqttDiscovery.ts');

const SUBSET = ['test/discoveryInvariants.test.ts', 'test/mqttDiscovery.test.ts'];

const MUTANTS = [
  // ── B3: the rules themselves ───────────────────────────────────────────────
  {
    id: 'i. ★ the currency rule stops firing (THE MONEY BUG)',
    file: DISC,
    find: "    if (unit && CURRENCY_UNITS.includes(unit) && !(dc === 'monetary' && sc === 'total')) {",
    to: "    if (false) { /* MUTANT */",
    why: 'A USD sensor declared as a measurement compiles a MEAN. It can never be an Energy-Dashboard cost source, and nothing anywhere says so.',
  },
  {
    id: 'ii. the currency rule accepts monetary WITHOUT total',
    file: DISC,
    find: "!(dc === 'monetary' && sc === 'total')",
    to: "!(dc === 'monetary') /* MUTANT */",
    why: 'device_class monetary alone still compiles no sum — this is the half-fix that looks right.',
  },
  {
    id: 'iii. USD/kWh is swept into the currency list',
    file: DISC,
    find: "const CURRENCY_UNITS: readonly string[] = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];",
    to: "const CURRENCY_UNITS: readonly string[] = ['USD', 'USD/kWh', 'EUR', 'GBP', 'CAD', 'AUD']; /* MUTANT */",
    why: 'A PRICE would be forced to device_class monetary, which describes an amount of money — and would break the one sensor HA mints its cost entity from.',
  },
  {
    id: 'iv. energy is allowed to be a measurement',
    file: DISC,
    find: "  energy: ['total', 'total_increasing'],",
    to: "  energy: ['total', 'total_increasing', 'measurement'], /* MUTANT */",
    why: 'HA rejects device_class energy + measurement outright; the entity never appears and the only signal is one log line.',
  },
  {
    id: 'v. the device_class/unit table stops being consulted',
    file: DISC,
    find: '      const allowedUnits = DEVICE_CLASS_UNITS[dc];',
    to: '      const allowedUnits = undefined as readonly string[] | undefined; /* MUTANT */',
    why: 'A power sensor carrying kWh would pass. HA rejects the entity and the publish still succeeds.',
  },
  {
    id: 'vi. a unit with no state_class is accepted',
    file: DISC,
    find: '    if (unit && !sc) {',
    to: '    if (false) { /* MUTANT */',
    why: 'The sensor compiles NO long-term statistics at all — invisible until someone opens the Statistics developer tool.',
  },
  {
    id: 'vii. total_increasing without a unit is accepted',
    file: DISC,
    find: "    if (sc === 'total_increasing' && !unit) {",
    to: '    if (false) { /* MUTANT */',
    why: 'A unitless accumulating sum the Energy Dashboard cannot consume and history mis-labels.',
  },
  {
    id: 'viii. duplicate unique_ids stop being detected',
    file: DISC,
    find: "    if (seenSensor.has(s.unique_id)) add(s.unique_id, 'duplicate-unique-id', 'appears twice in SENSORS');",
    to: '    /* MUTANT */',
    why: 'A collision silently drops one of the two entities; the publish count still reads correct.',
  },
  // ── B3: the waiver mechanism ───────────────────────────────────────────────
  {
    id: 'ix. ★ a waiver no longer needs a reason',
    file: DISC,
    find: "    waivers[unique_id]?.rule === rule && (waivers[unique_id]?.reason ?? '').trim().length > 0;",
    to: '    waivers[unique_id]?.rule === rule; /* MUTANT */',
    why: 'The waiver list is the ONLY place the intent is recorded. An empty reason turns it back into an unexplained suppression list.',
  },
  {
    id: 'x. a waiver suppresses every rule for that sensor',
    file: DISC,
    find: '    waivers[unique_id]?.rule === rule &&',
    to: '    waivers[unique_id] != null && /* MUTANT */',
    why: 'Waiving the currency rule would also hide a genuine device_class/unit error on the same sensor.',
  },
  // ── B6: the dynamic per-circuit configs ────────────────────────────────────
  {
    id: 'xviii. ★ B6: an absent watts reading publishes 0 instead of null',
    file: DISC,
    find: "    out[`circuit_${ch}_watts`] = typeof w === 'number' && Number.isFinite(w) ? Math.round(w) : null;",
    to: "    out[`circuit_${ch}_watts`] = typeof w === 'number' && Number.isFinite(w) ? Math.round(w) : 0; /* MUTANT */",
    why: 'On a measurement sensor a 0 is compiled into HA\'s mean as a positive claim that the circuit drew nothing — indistinguishable from a genuinely idle one.',
  },
  {
    id: 'xix. B6: the signature drops the power name',
    file: DISC,
    find: "    .map((c) => `${c.ch}:${entityName.get(c.ch) ?? ''}:${powerName.get(c.ch) ?? ''}`)",
    to: "    .map((c) => `${c.ch}:${entityName.get(c.ch) ?? ''}`) /* MUTANT */",
    why: 'v1.128.0 exactly: a published string changes, the signature does not move, and twelve entities keep stale names while every other entity is renamed.',
  },
  {
    id: 'xx. B6: a departed channel clears only its energy topic',
    file: DISC,
    find: "    .flatMap((ch) => [\n      `${prefix}/sensor/ecoflow_circuit_${ch}_lifetime_kwh/config`,\n      `${prefix}/sensor/ecoflow_circuit_${ch}_watts/config`,\n    ]);",
    to: "    .map((ch) => `${prefix}/sensor/ecoflow_circuit_${ch}_lifetime_kwh/config`); /* MUTANT */",
    why: 'An orphaned retained power config sits on the broker forever with nothing left to remove it.',
  },
  {
    id: 'xxi. B6: the power sensor is declared total_increasing',
    file: DISC,
    find: "          device_class: 'power',\n          state_class: 'measurement',\n          unit_of_measurement: 'W',",
    to: "          device_class: 'power',\n          state_class: 'total_increasing',\n          unit_of_measurement: 'W', /* MUTANT */",
    why: 'HA refuses device_class power with an accumulating state_class — the entity never appears, and only the new dynamic-config audit catches it.',
  },
  {
    id: 'xxii. B6: the power sensor unique_id collides with the energy one',
    file: DISC,
    find: '    const powerId = `ecoflow_circuit_${c.ch}_watts`;',
    to: '    const powerId = `ecoflow_circuit_${c.ch}_lifetime_kwh`; /* MUTANT */',
    why: 'HA persists an entity_id against the unique_id and the energy prefs wire stat_rate BY STRING — a collision silently drops one of the two entities and takes its Sankey leg with it.',
  },
  {
    id: 'xxiii. B6: the two field builders enumerate independently',
    file: DISC,
    find: '  for (const ch of circuitChannels(circuits, lifetimeKeys)) {',
    to: '  for (const ch of circuits.map((c) => c.ch)) { /* MUTANT */',
    why: 'Power and energy would drift on accumulator-only channels, and the drift is invisible — HA just shows `unknown` for whichever entity was forgotten.',
  },
  // ── B5: the connect sequence ───────────────────────────────────────────────
  {
    id: 'xi. ★ discovery is re-latched to the first connect (THE B5 DEFECT)',
    file: DISC,
    find: '  fx.publishDiscovery();\n  fx.invalidateCircuitDiscovery();',
    to: '  if (!latch.legacyCleared) fx.publishDiscovery();\n  fx.invalidateCircuitDiscovery(); /* MUTANT */',
    why: 'A broker that loses its retained store drops all ~90 configs and nothing ever republishes them — the exact shape of the v1.14.1 incident.',
  },
  {
    id: 'xii. the legacy clear runs on every connect',
    file: DISC,
    find: '  if (!latch.legacyCleared) {',
    to: '  if (true) { /* MUTANT */',
    why: 'Empty payloads to retired config topics, forever, on every reconnect — traffic that never stops and never says why.',
  },
  {
    id: 'xiii. the circuit signature is no longer invalidated',
    file: DISC,
    find: '  fx.invalidateCircuitDiscovery();',
    to: '  /* MUTANT */',
    why: 'The twelve per-circuit configs are retained on the same broker and vanish with the same store — they would not come back.',
  },
  {
    id: 'xiv. availability moves after discovery',
    file: DISC,
    find: '  fx.publishAvailability();\n  if (!latch.legacyCleared) {',
    to: '  if (!latch.legacyCleared) { /* MUTANT */',
    why: 'A retained LWT "offline" holds every entity unavailable no matter which configs follow it — 9+ hours of dark entities in the live incident.',
  },
  {
    id: 'xv. switch subscriptions are latched to the first connect',
    file: DISC,
    find: '  fx.subscribeSwitchCommands();',
    to: '  if (!latch.legacyCleared) fx.subscribeSwitchCommands(); /* MUTANT */',
    why: 'MQTT subscriptions do not survive a clean-session reconnect; the alarm-priority switches would go one-way silently.',
  },
  {
    id: 'xvi. the live handler stops resetting the circuit sig',
    file: DISC,
    find: '        circuitDiscoverySig = null;',
    to: '        /* MUTANT */',
    why: 'The extracted sequence would be correct and the REAL handler inert — the wire-it-to-the-production-bridge failure.',
  },
  {
    id: 'xvii. ★ the live handler also resets the orphan ledger',
    file: DISC,
    find: '        circuitDiscoverySig = null;',
    to: '        circuitDiscoverySig = null;\n        publishedCircuitChannels = []; /* MUTANT */',
    why: 'publishedCircuitChannels is the memory of what to CLEAR when a circuit disappears. Reset it and an orphaned retained config sits on the broker forever with nothing left to remove it.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-discovery-invariants: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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

const unexpected = survivors.filter((s) => !s.expectSurvivor);
const declared = MUTANTS.filter((m) => m.expectSurvivor);
const declaredThatDied = declared.filter((m) => !survivors.includes(m));

console.log(`\n${killed}/${MUTANTS.length} mutants killed (${declared.length} declared survivor(s))`);

if (declaredThatDied.length) {
  // A declared survivor that dies means the suite grew a constraint we did not
  // know it had. That is good news, but the declaration is now a lie.
  console.log('\nDECLARED SURVIVORS THAT WERE KILLED — remove the declaration:');
  for (const m of declaredThatDied) console.log(`  - ${m.id}`);
  process.exit(1);
}

if (unexpected.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of unexpected) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}

console.log('\npost-run: tree restored');
