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
const AN = resolve(SERVER, 'src/analytics.ts');

const SUBSET = ['test/energyFlowModel.test.ts', 'test/panelLoadSilent.test.ts', 'test/runwayLoadCarry.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the Cores are credited with delivering when their inverters output nothing',
    file: MODEL,
    find: '  const coresDelivering = acOut >= FLOW_EDGE_MIN_W;',
    to: '  const coresDelivering = true; /* MUTANT */',
    why: 'At a charge ramp the panel/main/Core meters disagree for ~30 s and the whole house is drawn flowing OUT of charging Cores (03:43: 3410 W).',
  },
  {
    id: 'ii. \u2605\u2605 with both sources, the Cores\u2019 share ignores their own meter',
    file: MODEL,
    find: '    coresToHouseW = Math.min(acOut, load);',
    to: '    coresToHouseW = load; /* MUTANT */',
    why: 'The grid\u2019s real share of an evening house vanishes: the whole load is drawn out of Cores reporting a fraction of it.',
  },
  {
    id: 'iii. \u2605\u2605\u2605 a frozen (offline / cloud-shadow) panel is read as live',
    file: MODEL,
    find: '    : panels.some((p) => !p.online || p.contentStaleSinceMs != null)',
    to: '    : false /* MUTANT */',
    why: 'The server zeroes a shadowed panel\u2019s grid reading; pairing that with the frozen house load draws a grid-fed house out of idle batteries.',
  },
  {
    id: 'iv. \u2605\u2605 the Cores\u2019 draw is taken from the server\u2019s importWatts even with a connection table',
    file: MODEL,
    find: '  const coresAcIn = connected.size > 0 ? acIn : grid ? (grid.importWatts ?? 0) : acIn;',
    to: '  const coresAcIn = grid?.importWatts ?? acIn; /* MUTANT */',
    why: 'importWatts also counts a source slot whose Core is not connected: a non-member\u2019s draw is drawn into a Batteries node that does not contain it.',
  },
  {
    id: 'iv-b. \u2605\u2605 with no connection table, every online DPU\u2019s acIn counts as grid',
    file: MODEL,
    find: '  const gridToCoresW = coresAcIn;',
    to: '  const gridToCoresW = acIn; /* MUTANT */',
    why: 'At cold boot a bench spare\u2019s wall charge is drawn as live grid into the home batteries \u2014 the case the server\u2019s importWatts fails safe for.',
  },
  {
    id: 'v. \u2605\u2605 with the Cores idle, the grid is not taken as the house\u2019s only source',
    file: MODEL,
    find: "    gridToHouseW = gridState === 'active' ? load : 0;",
    to: '    gridToHouseW = Math.min(Math.max(0, homeGridW - acIn), load); /* MUTANT */',
    why: 'At a charge ramp the main still reads its pre-ramp value, so the grid \u2192 house edge drops to 0 while the house is plainly on the grid.',
  },
  {
    id: 'vi. \u2605 the Grid node keeps a stale main that its fresher edges contradict',
    file: MODEL,
    find: '  const gridSupplyW = homeGridW > 0 && Math.abs(homeGridW - gridEdgesW) <= meterToleranceW ? homeGridW : gridEdgesW;',
    to: '  const gridSupplyW = Math.max(homeGridW, gridEdgesW); /* MUTANT */',
    why: 'When a charge ends the node keeps a stale 18.4 kW beside a 2.1 kW flow for up to a minute.',
  },
  {
    id: 'vii. \u2605\u2605\u2605 a silent panel reads 0 W again',
    file: MODEL,
    find: "    : panelState === 'absent'\n      ? acOut\n      : null;",
    to: "    : panelState === 'absent'\n      ? acOut\n      : 0; /* MUTANT */",
    why: 'A panel dropout renders as "the house draws nothing".',
  },
  {
    id: 'viii. \u2605\u2605 circuits are counted as legs',
    file: MODEL,
    find: '  const liveCircuits = groups.length > 0',
    to: '  const liveCircuits = false /* MUTANT */',
    why: '"9 circuits" on a six-circuit panel, beside an SHP2 card that says "Circuits (6)".',
  },
  {
    id: 'ix. \u2605\u2605\u2605 as the sole source, the Cores\u2019 edge is their own meter, not the box it points at',
    file: MODEL,
    find: '    coresToHouseW = load;\n',
    to: '    coresToHouseW = acOut; /* MUTANT */\n',
    why: 'The arrow and the Loads box disagree again (1925 W into "1.89 kW"; live 14427 W into "14.36 kW").',
  },
  {
    id: 'x. \u2605 a grid remainder under the edge floor is drawn as a flow',
    file: MODEL,
    find: '  if (gridToHouseW < FLOW_EDGE_MIN_W) gridToHouseW = 0;',
    to: '  /* MUTANT */',
    why: 'Meter disagreement of a few watts is drawn as the grid feeding a house the Cores are carrying.',
  },
  {
    id: 'x-b. \u2605\u2605 the house is not taken to be on the grid when the Cores stop',
    file: MODEL,
    find: '    ? homeGridW > 0 || coresAcIn >= FLOW_EDGE_MIN_W || houseOnGrid',
    to: '    ? homeGridW > 0 || coresAcIn >= FLOW_EDGE_MIN_W /* MUTANT */',
    why: 'For up to a minute after the Cores hand the house to the grid, the Loads node shows kilowatts with nothing feeding it and the grid reads "standby".',
  },
  {
    id: 'xi. \u2605\u2605 the card draws the Cores edge from its own arithmetic, not the model',
    file: CARD,
    find: 'watts={coresToHouseW} color={HUES.soc} period={period(coresToHouseW)} strokeW={strokeW(coresToHouseW)}',
    to: 'watts={load ?? 0} color={HUES.soc} period={period(load ?? 0)} strokeW={strokeW(load ?? 0)} /* MUTANT */',
    why: 'The model is correct and tested and the card ignores it \u2014 the fix ships inert.',
  },
  {
    id: 'xii. \u2605\u2605\u2605 the recorder stores a silent panel as a 0 W measurement',
    file: REC,
    find: '        let panelLoad: number | null = null;',
    to: '        let panelLoad: number | null = 0; /* MUTANT */',
    why: 'A dropout becomes a recorded "house drew 0 W" row that the Today tiles integrate and the night-charge load model learns from.',
  },
  {
    id: 'xiii. \u2605\u2605 the runway\u2019s carried-forward load never expires',
    file: AN,
    find: '    const carryOk = runwayLoadMeasuredAtMs != null && now - runwayLoadMeasuredAtMs <= RUNWAY_LOAD_CARRY_MAX_MS;',
    to: '    const carryOk = true; /* MUTANT */',
    why: 'A load captured before a panel went silent (an EV at 14 kW) keeps shortening the projected runway for as long as the silence lasts.',
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
