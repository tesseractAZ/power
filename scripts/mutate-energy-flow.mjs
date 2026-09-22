#!/usr/bin/env node
/**
 * mutate-energy-flow.mjs — committed harness for the v1.175.0 Energy flow model
 * (web/src/cards/energyFlowModel.ts + EnergyFlow.tsx) and the panel_load recording
 * (server/src/recorder.ts).
 *
 * WHY COMMITTED: every defect this release fixes rendered a confident, plausible picture.
 * A grid carrying the whole house was drawn as the house running on battery; a panel that
 * reported nothing was drawn — and RECORDED — as a 0 W house; the arrow into Loads and
 * the Loads box disagreed because they came from two meters. None of these fails a build
 * or throws; each only misleads the operator reading the headline card, which is exactly
 * when (a grid event, a panel dropout) the picture matters most.
 *
 *   node scripts/mutate-energy-flow.mjs
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
const MODEL = resolve(REPO, 'web/src/cards/energyFlowModel.ts');
const CARD = resolve(REPO, 'web/src/cards/EnergyFlow.tsx');
const REC = resolve(SERVER, 'src/recorder.ts');

const SUBSET = ['test/energyFlowModel.test.ts', 'test/panelLoadSilent.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the whole grid total is drawn into the batteries again',
    file: MODEL,
    find: '  const gridToCoresW = gridImportW;',
    to: '  const gridToCoresW = gridSupplyW; /* MUTANT */',
    why: 'A grid backstopping the house reads as the grid charging idle packs \u2014 the 03:30 picture, where 1.9 kW went "into" batteries nothing was charging.',
  },
  {
    id: 'ii. \u2605\u2605 the Cores\u2019 import is not subtracted from the main',
    file: MODEL,
    find: '  const gridToHouseRaw = Math.max(0, homeGridW - gridImportW);',
    to: '  const gridToHouseRaw = Math.max(0, homeGridW); /* MUTANT */',
    why: 'During any charge the grid edge claims the house\u2019s whole load, and the Cores\u2019 real delivery to the house disappears from the card.',
  },
  {
    id: 'iii. \u2605\u2605 the grid \u2192 house edge is not capped at the house',
    file: MODEL,
    find: '  const gridToHouseW = load != null ? Math.min(gridToHouseRaw, load) : gridToHouseRaw;',
    to: '  const gridToHouseW = gridToHouseRaw; /* MUTANT */',
    why: 'Under a 16 kW charge the ~1.1 kW the main and Core meters disagree by is drawn as house load: 3084 W into a 1996 W box.',
  },
  {
    id: 'iv. \u2605\u2605\u2605 a silent panel reads 0 W again',
    file: MODEL,
    find: '    : shp2\n      ? null\n      : acOut;',
    to: '    : shp2\n      ? 0 /* MUTANT */\n      : acOut;',
    why: 'A panel dropout renders as "the house draws nothing" \u2014 a confident, wrong reading indistinguishable from a real one.',
  },
  {
    id: 'v. \u2605\u2605 circuits are counted as legs',
    file: MODEL,
    find: '  const liveCircuits = groups.length > 0',
    to: '  const liveCircuits = false /* MUTANT */',
    why: '"9 circuits" on a six-circuit panel, beside an SHP2 card that says "Circuits (6)".',
  },
  {
    id: 'vi. \u2605\u2605\u2605 the Cores \u2192 house edge is read from the Cores\u2019 own meter again',
    file: MODEL,
    find: '  const coresResidual = load != null ? Math.max(0, load - gridToHouseW) : acOut;',
    to: '  const coresResidual = acOut; /* MUTANT */',
    why: 'The arrow and the box it points at disagree again (1925 W into "1.89 kW"; live 14427 W into "14.36 kW").',
  },
  {
    id: 'vii. \u2605 meter disagreement below the edge floor is drawn as delivery',
    file: MODEL,
    find: '  const coresToHouseW = coresResidual < FLOW_EDGE_MIN_W ? 0 : coresResidual;',
    to: '  const coresToHouseW = coresResidual; /* MUTANT */',
    why: 'At 03:30 the card would claim "4 W" out of Cores whose inverters output 0 W.',
  },
  {
    id: 'viii. \u2605\u2605 the card draws the Cores edge from its own arithmetic, not the model',
    file: CARD,
    find: 'watts={coresToHouseW} color={HUES.soc} period={period(coresToHouseW)} strokeW={strokeW(coresToHouseW)}',
    to: 'watts={acOut} color={HUES.soc} period={period(acOut)} strokeW={strokeW(acOut)} /* MUTANT */',
    why: 'The model is correct and tested and the card ignores it \u2014 the fix ships inert.',
  },
  {
    id: 'ix. \u2605\u2605\u2605 the recorder stores a silent panel as a 0 W measurement',
    file: REC,
    find: '        let panelLoad: number | null = null;',
    to: '        let panelLoad: number | null = 0; /* MUTANT */',
    why: 'A dropout becomes a recorded "house drew 0 W" row that the Today tiles integrate and the night-charge load model learns from.',
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
console.log(`mutate-energy-flow: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
