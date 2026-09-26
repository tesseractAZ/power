#!/usr/bin/env node
/**
 * mutate-readiness-gate.mjs — committed harness for v1.186.0: the plan-trajectory verdict
 * is graded on the trough the plan was SIZED against (not the whole-house disclosure
 * trough), and the readiness gate sets aside the pre-v1.186.0 disclosure-trough flags
 * while still counting every sizing-trough and realized breach.
 *
 *   node scripts/mutate-readiness-gate.mjs
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
const ADVISOR = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const GATE = resolve(SERVER, 'src/nightChargeGate.ts');
const RECORDER = resolve(SERVER, 'src/recorder.ts');

const SUBSET = ['test/readinessGate.test.ts', 'test/nightChargeGate.test.ts', 'test/edges.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the scorer grades the disclosure trough again',
    file: ADVISOR,
    find: '  const trough = plan?.cushionTroughSocPct ?? null;',
    to: '  const trough = plan?.minProjSocPct ?? null; /* MUTANT */',
    why: 'Every night whose plan held the cushion is stored as breached; the gate never leaves BLOCKED.',
  },
  {
    id: 'ii. ★★ rounding reads as a breach',
    file: ADVISOR,
    find: '      : trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;',
    to: '      : trough < line; /* MUTANT */',
    why: 'A plan sized exactly to its line, 0.01 %-pt under it after rounding, becomes an engine-fault strike.',
  },
  {
    id: 'iii. ★★★ a plan without its sizing trough falls back to the disclosure trough',
    file: ADVISOR,
    find: '      ? null\n      : trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;',
    to: '      ? (plan?.minProjSocPct != null ? plan.minProjSocPct < plan.reserveFloorPct + plan.cushionPct - 1e-9 : null) /* MUTANT */\n      : trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;',
    why: 'A row planned before v1.186.0 and scored after it is stored as a phantom breach instead of unknown.',
  },
  {
    id: 'iv. ★★★ the plan records the whole-house trough as its sizing trough',
    file: ADVISOR,
    find: '  const cushionTroughSocPct = round2((minProjKwh / fullKwh) * 100);',
    to: '  const cushionTroughSocPct = round2((houseWithBuy.minKwh / fullKwh) * 100); /* MUTANT */',
    why: 'The persisted trough is the 0% disclosure figure again, so the fix changes nothing on the islanded basis.',
  },
  {
    id: 'v. ★★ the line is the legacy flat band',
    file: ADVISOR,
    find: '  const cushionLineSocPct = round2((targetFloorKwh / fullKwh) * 100);',
    to: '  const cushionLineSocPct = round2(reserveFloorPct + cushionPct); /* MUTANT */',
    why: 'The islanded cushion is graded against floor + 15%, and a disabled cushion against a cushion it does not have.',
  },
  {
    id: 'vi. ★★ a HOLD night records the disclosure trough',
    file: ADVISOR,
    find: '      cushionTroughSocPct: round2((baselineTrough.minKwh / fullKwh) * 100),',
    to: '      cushionTroughSocPct: baselineMinSocPct, /* MUTANT */',
    why: 'Every islanded hold night becomes a phantom strike.',
  },
  {
    id: 'vii. ★★★ the gate trusts every stored trajectory flag',
    file: GATE,
    find: '    asNum(r.cushion_trough_soc_pct) != null || r.cushion_shortfall == null;',
    to: '    true; /* MUTANT */',
    why: 'The four live phantom strikes count again: hard BLOCKED, and the real blockers stay hidden.',
  },
  {
    id: 'viii. ★★★ the gate ignores a sizing-trough verdict',
    file: GATE,
    find: '    asNum(r.cushion_trough_soc_pct) != null || r.cushion_shortfall == null;',
    to: '    r.cushion_shortfall == null; /* MUTANT */',
    why: 'A genuine engine fault (plan claimed hold, its own sizing trough breached) is never a strike.',
  },
  {
    id: 'ix. ★★★ a set-aside night loses its REALIZED judgement',
    file: GATE,
    find: '    const realizedStrike = truthy(r.actuated) && truthy(r.cushion_breached);',
    to: '    const realizedStrike = truthy(r.actuated) && truthy(r.cushion_breached) && trajGradedOnSizingTrough(r); /* MUTANT */',
    why: 'An actuated night that really went below floor+cushion is not a strike because its plan row is pre-v1.186.0.',
  },
  {
    id: 'x. ★★ the ledger allowlist drops the two columns',
    file: RECORDER,
    find: "  'cushion_trough_soc_pct', 'cushion_line_soc_pct',",
    to: '  /* MUTANT */',
    why: 'The sizing trough is silently never persisted, so every future verdict is unknown and the detector cannot fire.',
  },
  {
    id: 'xi. ★★★ the gate trusts the stored flag over the sizing columns',
    file: GATE,
    find: '    if (trough != null && line != null) return trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;',
    to: '    /* MUTANT */',
    why: 'A boundary row a reverted scorer stamped breached brings the phantom engine-fault BLOCK back.',
  },
  {
    id: 'xii. ★★ the derived verdict drops the rounding tolerance',
    file: GATE,
    find: '    if (trough != null && line != null) return trough < line - PLAN_TRAJ_BREACH_TOLERANCE_PCT;',
    to: '    if (trough != null && line != null) return trough < line; /* MUTANT */',
    why: 'A 0.01 %-pt rounding residual is graded as an engine-fault strike.',
  },
  {
    id: 'xiii. ★★ an overruled flag is dropped silently from the set-aside count',
    file: GATE,
    find: '    !truthy(r.cushion_shortfall) && trajFlagged(r) && !(trajBreached(r) && trajGradedOnSizingTrough(r))',
    to: '    !truthy(r.cushion_shortfall) && trajFlagged(r) && !trajGradedOnSizingTrough(r) /* MUTANT */',
    why: 'A stored breach flag stops counting with no trace in trajStrikesSetAside.',
  },
  {
    id: 'xiv. ★★ the derived verdict ignores the confidence tier',
    file: GATE,
    find: "    if (r.confidence_tier !== 'forecast') return false;",
    to: '    /* MUTANT */',
    why: 'A climatology-tier plan trajectory is judged as an engine fault (section 3.3: forecast-tier only).',
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
console.log(`mutate-readiness-gate: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
