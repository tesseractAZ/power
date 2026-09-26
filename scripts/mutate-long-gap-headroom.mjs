#!/usr/bin/env node
/**
 * mutate-long-gap-headroom.mjs — committed harness for the v1.186.0 long-gap headroom
 * (server/src/nightChargeAdvisor.ts pessimisticPrePeakSurplus + the cost ceiling, and
 * its production bridge in index.ts).
 *
 * WHY COMMITTED: before a long gap (the v1.168.0 Thursday rule) the cost ceiling set the
 * solar headroom aside and bought to ARB_COST_MAX_SOC_PCT. Measured 2026-09-24→25: the pool
 * was full before 11:00 and the Cores curtailed 12.27 kWh of PV that day. The ceiling now
 * keeps the P10 (low-PV) surplus up to the evening on-peak start. Each mutant below
 * reverts ONE rail of that; the suite must kill it by a named assertion.
 *
 *   node scripts/mutate-long-gap-headroom.mjs
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
const NCA = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IDX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/thursdayHeadroom.test.ts', 'test/longGapCeiling.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the long gap sets the solar headroom aside again',
    file: NCA,
    find: '  const longGapP10Known = longGapP10Kwh != null && Number.isFinite(longGapP10Kwh);',
    to: '  const longGapP10Known = false; /* MUTANT */',
    why: 'A sunny long-gap night buys to 90% and the sun is curtailed from mid-morning — the 2026-09-25 loss, rebuilt.',
  },
  {
    id: 'ii. ★★★ a normal night reads the P10 as its headroom',
    file: NCA,
    find: '  const costSurplusKwh: number | null = longGap ? (longGapP10Known ? Math.max(0, longGapP10Kwh) : null)',
    to: '  const costSurplusKwh: number | null = (longGap || longGapP10Known) ? (longGapP10Known ? Math.max(0, longGapP10Kwh) : null) /* MUTANT */',
    why: 'The measured median path is replaced on every night — the non-long-gap ceiling changes silently.',
  },
  {
    id: 'iii. ★★ a negative P10 surplus is reported as-is',
    file: NCA,
    find: '? (longGapP10Known ? Math.max(0, longGapP10Kwh) : null)',
    to: '? (longGapP10Known ? longGapP10Kwh : null) /* MUTANT */',
    why: 'The ledger records a negative solar surplus the ceiling never used.',
  },
  {
    id: 'iv. ★ the rationale says "set aside" on a P10 night',
    file: NCA,
    find: '  const longGapNote = costSurplusBasis === \'p10\'',
    to: '  const longGapNote = false /* MUTANT */',
    why: 'The 21:30 notice claims no headroom while the ceiling kept one.',
  },
  {
    id: 'v. ★★★ the surplus runs through the evening on-peak',
    file: NCA,
    find: '    if (o.isOnPeakAt(t)) { untilMs = t; break; }',
    to: '    if (false) { untilMs = t; break; } /* MUTANT */',
    why: 'Surplus the sun makes during the peak is counted as room before it — the pack enters the dearest hours short.',
  },
  {
    id: 'vi. ★★ the on-peak start hour itself counts',
    file: NCA,
    find: '    if (h.ts < o.windowEndMs || h.ts >= untilMs) continue;',
    to: '    if (h.ts < o.windowEndMs || h.ts > untilMs) continue; /* MUTANT */',
    why: 'An off-by-one widens the headroom by the first on-peak hour.',
  },
  {
    id: 'vii. ★★★ a non-finite P10 is skipped instead of voiding the sum',
    file: NCA,
    find: '    if (!Number.isFinite(h.p10W) || !Number.isFinite(h.loadW)) return { kwh: null, untilMs };',
    to: '    if (!Number.isFinite(h.p10W) || !Number.isFinite(h.loadW)) continue; /* MUTANT */',
    why: 'A hole in the pessimistic forecast is read as a known surplus — absence taken as evidence.',
  },
  {
    id: 'viii. ★★ no covered hour reads as a known zero surplus',
    file: NCA,
    find: '  return { kwh: covered ? round2(kwh) : null, untilMs };',
    to: '  return { kwh: round2(kwh), untilMs }; /* MUTANT */',
    why: 'The ledger reports a P10 basis on a night no P10 was known.',
  },
  {
    id: 'ix. ★★★ the planner inputs drop the P10',
    file: NCA,
    find: '    longGapAhead,\n    prePeakPvSurplusP10Kwh,\n    buyDebiasFactor,',
    to: '    longGapAhead,\n    buyDebiasFactor, /* MUTANT */',
    why: 'Computed and never reaching the sizing — the v1.125.0 field-copy trap.',
  },
  {
    id: 'x. ★★★ index.ts sizes the headroom on the MEDIAN, not the P10',
    file: IDX,
    find: '    if (fh) prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p10W, loadW: fh.forecastLoadW });',
    to: '    if (fh) prePeakP10Hours.push({ ts: pb.ts, p10W: pb.p50W, loadW: fh.forecastLoadW }); /* MUTANT */',
    why: 'An ordinary day\'s forecast sizes the long-gap buy; a cloudier-than-median weekend starts short.',
  },
  {
    id: 'xi. ★★★ index.ts ignores the on-peak start',
    file: IDX,
    find: '      isOnPeakAt: (ts) => rateAt(tariffModel, ts).isOnPeak,',
    to: '      isOnPeakAt: () => false, /* MUTANT */',
    why: 'The live span always runs 14 h — through the evening peak.',
  },
  {
    id: 'xii. ★★★ index.ts computes the P10 and never passes it',
    file: IDX,
    find: '    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, prePeakPvSurplusP10Kwh,',
    to: '    morningPvSurplusP50Kwh, longGapAhead: nightLongGapAhead, /* MUTANT */',
    why: 'The live planner keeps the full long-gap buy while every unit test passes.',
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
console.log(`mutate-long-gap-headroom: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
