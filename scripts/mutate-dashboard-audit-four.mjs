#!/usr/bin/env node
/**
 * mutate-dashboard-audit-four.mjs — committed harness for v1.182.0: Today's "% measured" covers
 * the home, the Battery page's fleet figures cover home packs, the Alerts badge counts a learned
 * CRITICAL, the Energy flow title keeps its spare qualifier, and the night-charge card shows the
 * reserve that will be written and only tonight's banner.
 *
 *   node scripts/mutate-dashboard-audit-four.mjs
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
const AGG = resolve(SERVER, 'src/aggregator.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const SCOPE = resolve(REPO, 'web/src/cards/batteryScope.ts');
const PRIO = resolve(REPO, 'web/src/alertPriority.ts');
const FLOW = resolve(REPO, 'web/src/cards/energyFlowModel.ts');
const NIGHT = resolve(REPO, 'web/src/cards/nightChargeText.ts');

const SUBSET = ['test/dashboardAuditFour.test.ts', 'test/aggregator.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605 home coverage counts every device again (bench Cores dilute or inflate it)',
    file: AGG,
    find: "    if (p.kind === 'shp2' || (p.kind === 'dpu' && isShp2Connected(d.sn, connected))) {",
    to: '    if (true) { /* MUTANT */',
    why: 'Today reads "100% measured" off bench series while a home figure is missing.',
  },
  {
    id: 'i-b. \u2605\u2605 home coverage weighs per SERIES again (a dark Core is 1 series against ~14)',
    file: AGG,
    find: '      if (own.length > 0) homeCoverageAccum.push(own.reduce((s, v) => s + v, 0) / own.length); // one value per device',
    to: '      homeCoverageAccum.push(...own); /* MUTANT */',
    why: 'A third of the home dark still reads "97% measured".',
  },
  {
    id: 'ii. \u2605\u2605 a silent panel reads as measured',
    file: AGG,
    find: "      const plCov = pl && pl.totalMs > 0 ? pl.coverageMs / pl.totalMs : 0; // v1.182.0",
    to: '      const plCov = 1; /* MUTANT */',
    why: 'Panel load shows a confident 0 Wh beside "100% measured".',
  },
  {
    id: 'iii. \u2605\u2605 every pack is tagged home (bench packs back in the fleet capacity)',
    file: AN,
    find: '  return packs.map((p) => ({ ...p, home: isShp2Connected(p.sn, connected) }));',
    to: '  return packs.map((p) => ({ ...p, home: true })); /* MUTANT */',
    why: '"Fleet capacity" sums 24 packs \u2014 147 kWh \u2014 with 9 on bench spares that cannot power the house.',
  },
  {
    id: 'iv. \u2605 homePacks keeps bench packs',
    file: SCOPE,
    find: '  const home = packs.filter((p) => p.home !== false);',
    to: '  const home = packs; /* MUTANT */',
    why: 'The scoping helper scopes nothing.',
  },
  {
    id: 'v. \u2605\u2605 the badge ignores a learned CRITICAL again',
    file: PRIO,
    find: "  const learnedCritical = alerts.filter((a) => a.source === 'learned' && priorityOf(a) === 'critical').length;",
    to: '  const learnedCritical = 0; /* MUTANT */',
    why: 'A critical anomaly sits behind an empty Alerts tab badge.',
  },
  {
    id: 'vi. \u2605 the spare qualifier vanishes while membership is unknown',
    file: FLOW,
    find: '    membershipUnknown: connected.size === 0',
    to: '    membershipUnknown: false && connected.size === 0 /* MUTANT */',
    why: 'Bench spares are drawn as home batteries with nothing to say so.',
  },
  {
    id: 'vii. \u2605\u2605 the card advertises the unclamped reserve',
    file: NIGHT,
    find: '  if (cap != null && rounded > cap) return',
    to: '  if (false && cap != null && rounded > cap) return /* MUTANT */',
    why: '"Reserve set to 94%" while the panel will sit at 50.',
  },
  {
    id: 'viii. \u2605 last night\u2019s completed banner stays up all day',
    file: NIGHT,
    find: '  if (a.revertedAtMs != null) return nowMs - (a.revertVerifiedAtMs ?? a.revertedAtMs) < COMPLETED_BANNER_MS;',
    to: '  if (a.revertedAtMs != null) return true; /* MUTANT */',
    why: '"Completed \u2014 reserve restored" at 4 PM reads as something happening now.',
  },
  {
    id: 'viii-b. \u2605\u2605 an unconfirmed restore is hidden like a completed one',
    file: NIGHT,
    find: '  if (revertUnconfirmed(a)) return true;',
    to: '  /* MUTANT */',
    why: 'The reserve is still raised, the actuator is escalating, and the card goes quiet six hours after the cloud\u2019s ACK.',
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
console.log(`mutate-dashboard-audit-four: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
