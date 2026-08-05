#!/usr/bin/env node
/**
 * mutate-peak-grid-draw.mjs — committed mutation harness for the v1.70.0 on-peak
 * grid-to-battery detector (server/src/peakGridDraw.ts).
 *
 * WHY COMMITTED: on 2026-08-04 the plant spent an on-peak afternoon importing ~6.4 kW
 * into the battery at 44.4 c/kWh — roughly $2.87/h for energy the overnight window buys
 * at 17c or less — and nothing noticed. This module is the guard, so "the tests would
 * catch a regression" has to be demonstrable rather than asserted.
 *
 * Mutant `iii` is the one that matters most and is the easiest to introduce while
 * "simplifying": dropping the below-reserve guard. That mutation makes the detector
 * MORE sensitive, every remaining test still describes a firing alert, and the harm is
 * invisible in review — the alert would start advising the operator to stop buying back
 * outage protection on a depleted pack. In a Phoenix summer that is a safety regression
 * wearing the costume of a cost optimisation.
 *
 *   node scripts/mutate-peak-grid-draw.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the harness
 *   ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run git
 *   add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const PEAK = resolve(SERVER, 'src/peakGridDraw.ts');

const SUBSET = ['test/peakGridDraw.test.ts'];

const MUTANTS = [
  {
    id: 'i. PV is ignored when working out what the grid owes the house',
    find: '  const loadNotCoveredByPv = Math.max(0, panelLoadW - pvW);',
    to: '  const loadNotCoveredByPv = panelLoadW; /* MUTANT */',
    why: 'Under-counts grid-to-battery by the PV output, hiding the condition on sunny afternoons.',
  },
  {
    id: 'ii. the residual is allowed to go negative',
    find: '  return Math.max(0, gridImportW - loadNotCoveredByPv);',
    to: '  return gridImportW - loadNotCoveredByPv; /* MUTANT */',
    why: 'A negative "charge rate" would flow into the cost maths and print a negative bill.',
  },
  {
    id: 'iii. ★ the below-reserve safety guard is removed',
    find: `  if (i.socPct != null && i.reserveSocPct != null
      && i.socPct <= i.reserveSocPct + cfg.reserveHeadroomPct) {
    return idle('below-reserve');
  }`,
    to: '  /* MUTANT */',
    why: 'The alert would fire on a depleted pack, advising the operator to stop restoring outage protection to save money.',
  },
  {
    id: 'iv. fires off-peak too',
    find: "  if (!slice.isOnPeak) return idle('off-peak');",
    to: '  /* MUTANT */',
    why: 'Off-peak charging is the DESIRED behaviour; alerting on it trains the operator to ignore the alert.',
  },
  {
    id: 'v. fires during an outage',
    find: "  if (!i.gridPresent) return idle('outage');",
    to: '  /* MUTANT */',
    why: 'There is no grid to buy from during an outage — a cost alert then is pure noise at the worst moment.',
  },
  {
    id: 'vi. the dwell is removed (fires on any transient)',
    find: '    active: heldForMs >= cfg.dwellMs,',
    to: '    active: true, /* MUTANT */',
    why: 'An EV plugging in or a compressor start would raise a cost alert every time.',
  },
  {
    id: 'vii. the noise floor is removed',
    find: '  if (toBattery < cfg.minChargeW) return idle(null);',
    to: '  /* MUTANT */',
    why: 'Two different meters disagreeing by a few hundred watts would read as a buying decision.',
  },
  {
    id: 'viii. missing telemetry is treated as zero rather than unknown',
    find: "  if (i.gridImportW == null || i.panelLoadW == null || i.pvW == null) return idle('insufficient-data');",
    to: '  if (false) { return idle(null); } /* MUTANT */',
    why: 'A telemetry gap would fabricate a verdict from absent data.',
  },
  {
    id: 'ix. ★ cost is fabricated when rates are unconfirmed',
    find: `  const centsPerHour = slice.centsPerKwh == null ? null
    : (toBattery / 1000) * slice.centsPerKwh;`,
    to: '  const centsPerHour = (toBattery / 1000) * (slice.centsPerKwh ?? 44.4); /* MUTANT */',
    why: 'Breaks the null-over-fabrication discipline: an unconfirmed tariff would print a confident dollar figure.',
  },
  {
    id: 'x. severity escalated to critical',
    find: "    severity: 'warning' as const,",
    to: "    severity: 'critical' as const, /* MUTANT */",
    why: 'Money would ring the same audible tier as a grid loss, devaluing the tier that must never be ignored.',
  },
  {
    id: 'xi. onset advances instead of being held (dwell never elapses)',
    find: '  if (onsetMs == null) onsetMs = nowMs;',
    to: '  onsetMs = nowMs; /* MUTANT */',
    why: 'The dwell clock would restart every tick, so a sustained condition could never reach the threshold.',
  },
  {
    id: 'xii. ★ evaluatePeakDraw never threads the onset (alert can never fire)',
    find: '  const onset = trackOnset(holds, i.nowMs);',
    to: '  const onset = null; trackOnset(holds, i.nowMs); /* MUTANT */',
    why: 'The single most dangerous regression: every unit test on assessPeakDraw still passes, the module looks fully wired, and the alert simply never fires in production.',
  },
  {
    id: 'xiii. a suppressed condition still accrues dwell',
    find: '  const holds = probe.suppressed === null && probe.gridToBatteryW > 0;',
    to: '  const holds = probe.gridToBatteryW >= 0; /* MUTANT */',
    why: 'A depleted pack sitting below the reserve would age into a cost alert the moment it crossed the headroom.',
  },
  {
    id: 'xiv. ★ core attribution silently drops the biggest drawer',
    find: '    .sort((a, b) => b.acInWatts - a.acInWatts);',
    to: '    .sort((a, b) => a.acInWatts - b.acInWatts); /* MUTANT */',
    why: 'The operator would be pointed at the least guilty Core first — worse than no attribution.',
  },
  {
    id: 'xv. idle Cores are named as culprits',
    find: '    .filter((c) => c.acInWatts >= CORE_ATTRIBUTION_MIN_W)',
    to: '    .filter(() => true) /* MUTANT */',
    why: 'Every Core would be listed, including ones at 0 W, making the report useless.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const original = readFileSync(PEAK, 'utf8');
let killed = 0;
const survivors = [];
console.log(`mutate-peak-grid-draw: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    writeFileSync(PEAK, original);
    process.exit(2);
  }
  try {
    writeFileSync(PEAK, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } } // confirm against the FULL suite
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(PEAK, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
