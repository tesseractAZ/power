#!/usr/bin/env node
/**
 * mutate-v1187-3h.mjs — committed harness for v1.187.3 group H: alerts and announcements.
 *
 * (1) ems-window-1: the EMS parallel band is relative (it follows the Core's own voltage), so
 * `ems-volt-<sn>` is an info / Low notice, audible:false, with an honest title and detail (EN, ES):
 * it never pushes, never raises or voices the condition; cell-ovp-* still pages. Its cleared rows
 * keep the warning eviction tier (CLEARED_INFO_KEPT_AS_WARNING_PREFIXES). Mutants E-i..E-ix.
 *
 * (2) ems-window-2: the recorder stores ems_para_vol_min_mv / ems_para_vol_max_mv beside bat_vol.
 * Mutants R-i..R-iii.
 *
 * (3) general-2: peer-voldiff is in TELEMETRY_FAMILY_BASIS, so pre-v1.187.3 lines (which counted
 * the low side v1.187.1 muted) are not replayed; the boot line names each basis's reason.
 * Mutants T-i..T-iii.
 *
 * (4) general-3: a push auto-tuned to [Low] still owes its "Resolved:" (the card dismissal); an
 * ISA priority turned off since the push still suppresses it. Mutants S-i..S-iii.
 *
 * (5) restart-continuation-allclear: a green that has stood its dwell on a settled alert set after
 * a restart is a recovery, announced once (isRestartRecovery); yellow continuation and the silent
 * boot green are unchanged. Mutants B-i..B-xiii.
 *
 *   node scripts/mutate-v1187-3h.mjs
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
const AL = resolve(SERVER, 'src/alerts.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AT = resolve(SERVER, 'src/alertTelemetry.ts');
const BR = resolve(SERVER, 'src/broadcast.ts');
const IX = resolve(SERVER, 'src/index.ts');
const RC = resolve(SERVER, 'src/recorder.ts');
const TT = resolve(SERVER, 'src/ttsService.ts');

const SUBSET = [
  'test/restartRecoveryAllClear.test.ts',
  'test/emsBandNotice.test.ts',
  'test/clearedLedgerRetention.test.ts',
  'test/recorderEmsBand.test.ts',
  'test/peerVoldiffTelemetryRebase.test.ts',
  'test/mpptFamilyTelemetryRebase.test.ts',
  'test/autoTuneOwedResolve.test.ts',
  'test/demotedPushResolve.test.ts',
  'test/alertResolveEvidence.test.ts',
  'test/owedResolveAfterMute.test.ts',
  'test/peerSpreadTopOfChargeAudible.test.ts',
];

const MUTANTS = [
  /* ── (1) the EMS band notice ─────────────────────────────────────────── */
  {
    id: 'E-i. ★★★ the notice is a warning again',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'warning', priority: 'low', audible: false, category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'A relative band at the top of charge pushes and counts toward the condition again.',
  },
  {
    id: 'E-ii. ★★★ a warning with no explicit priority (ISA High, the pre-v1.187.3 rule)',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'The 10-01 13:25 [High] push, yellow and spoken alarm return.',
  },
  {
    id: 'E-iii. ★★ the audible gate is dropped',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'The belt-and-braces audible:false is not pinned.',
  },
  {
    id: 'E-iv. ★★★ the notice is never raised (the card is lost)',
    file: AL,
    find: '      if (batMv < p.emsParaVolMinMv || batMv > p.emsParaVolMaxMv) {',
    to: '      if (false) { /* MUTANT */',
    why: 'The band episode is no longer shown at all.',
  },
  {
    id: 'E-v. ★★ the detail always says "below"',
    file: AL,
    find: "${batMv < p.emsParaVolMinMv ? 'below' : 'above'}",
    to: "${'below' /* MUTANT */}",
    why: 'A grid-charge onset above the band reads as below it.',
  },
  {
    id: 'E-vi. ★★ the old title (a "window", read as a limit)',
    file: AL,
    find: "          title: 'Pack voltage swing outside EMS band',",
    to: "          title: 'Pack voltage outside EMS window', /* MUTANT */",
    why: 'The card claims a limit that does not exist.',
  },
  {
    id: 'E-vii. ★ the old Spanish title ("outside the permitted range")',
    file: TT,
    find: "  ['ems-volt', 'Oscilación de voltaje fuera de la banda del EMS'],",
    to: "  ['ems-volt', 'Voltaje de batería fuera del rango permitido'], /* MUTANT */",
    why: 'The Spanish title still claims a limit.',
  },
  {
    id: 'E-viii. ★★★ an ems-volt row is evicted as info (first out of a full ledger)',
    file: AM,
    find: "    return s === 'info' && typeof id === 'string' && CLEARED_INFO_KEPT_AS_WARNING_PREFIXES.some((p) => id.startsWith(p)) ? 'warning' : s;",
    to: '    return s; /* MUTANT */',
    why: 'Each band episode (and warranty evidence) leaves the ledger on the next clear.',
  },
  {
    id: 'E-ix. ★★ the kept-as-warning list is empty',
    file: AM,
    find: "export const CLEARED_INFO_KEPT_AS_WARNING_PREFIXES: readonly string[] = ['ems-volt-'];",
    to: 'export const CLEARED_INFO_KEPT_AS_WARNING_PREFIXES: readonly string[] = []; /* MUTANT */',
    why: 'As E-viii.',
  },
  /* ── (2) the recorder ────────────────────────────────────────────────── */
  {
    id: 'R-i. ★★★ the band floor is not recorded',
    file: RC,
    find: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv);",
    to: '        /* MUTANT */',
    why: 'An episode cannot be checked against batVol afterwards.',
  },
  {
    id: 'R-ii. ★★★ the band ceiling is not recorded',
    file: RC,
    find: "        push('ems_para_vol_max_mv', dpu.emsParaVolMaxMv);",
    to: '        /* MUTANT */',
    why: 'As R-i, for the upper edge.',
  },
  {
    id: 'R-iii. ★★ a missing band is recorded as 0',
    file: RC,
    find: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv);",
    to: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv ?? 0); /* MUTANT */",
    why: 'A fabricated 0 V floor reads as a measurement.',
  },
  /* ── (3) the peer-voldiff telemetry basis ────────────────────────────── */
  {
    id: 'T-i. ★★★ peer-voldiff is not rebased',
    file: AT,
    find: "  'peer-voldiff': 'peer-voldiff-high-side',",
    to: '  /* MUTANT */',
    why: 'The low-side pairs v1.187.1 muted keep the family at the Rule 2 cutoff until they age out.',
  },
  {
    id: 'T-ii. ★★ the boot line gives the MPPT reason for every family',
    file: AM,
    find: "  const dropped = [...new Set(families.map((f) => TELEMETRY_BASIS_DROPPED[telemetryBasisFor(f) ?? ''] ?? 'episodes an earlier rule counted'))];",
    to: "  const dropped = ['cooler-than-typical and load-explained MPPT episodes']; /* MUTANT */",
    why: 'The log says MPPT episodes were set aside when it was the peer cell spread.',
  },
  {
    id: 'T-iii. ★★ the boot line drops the lifted verdicts',
    file: AM,
    find: '      log(rebasedReplayLine(r, liftedIn(r.rebasedFamilies)));',
    to: '      log(rebasedReplayLine(r, [])); /* MUTANT */',
    why: 'Which demotion or silence the rebase lifted is no longer said.',
  },
  /* ── (4) the resolve of a demoted push ───────────────────────────────── */
  {
    id: 'S-i. ★★★ the resolve qualifies the alert\'s last-tick severity, not the dispatched one',
    file: AM,
    find: '    qualifies(t.notifiedSeverity ?? t.alert.severity, minSeverity)',
    to: '    qualifies(t.alert.severity, minSeverity) /* MUTANT */',
    why: 'A peer outlier that reads info on its last tick strands the card its warning push opened.',
  },
  {
    id: 'S-ii. ★★★ a demoted family owes no resolve (the v1.88.0 exception, by the rollup)',
    file: AM,
    find: '      } else if (shouldSendResolve(t, cfg.notifyResolved, cfg.minSeverity)) {',
    to: '      } else if (shouldSendResolve(t, cfg.notifyResolved, cfg.minSeverity) && !telemetry.get(familyOf(id))?.warningDemotedToInfo) { /* MUTANT */',
    why: 'The 10-01 [Low] peer cell-spread card stands in the drawer after its condition cleared.',
  },
  {
    id: 'S-iii. ★★★ the priority-disabled exception is lost for resolves',
    file: AM,
    find: '    if (!isPriorityEnabled(priorityOf(alert))) {',
    to: "    if (kind === 'new' && !isPriorityEnabled(priorityOf(alert))) { /* MUTANT */",
    why: 'A priority the operator turned off still sends its resolve.',
  },
  /* ── (5) the restart recovery ────────────────────────────────────────── */
  {
    id: 'B-i. ★★★ the tick never takes a recovery',
    file: BR,
    find: '      && isRestartRecovery(continuationBaseline, level, greenSinceMs, Date.now(), alertSetSettled())',
    to: '      && false /* MUTANT */',
    why: 'The 10-01 all-clear is adopted in silence; the cleared warning stays the last words.',
  },
  {
    id: 'B-ii. ★★★ the tick reads the alert set as always settled',
    file: BR,
    find: '      && isRestartRecovery(continuationBaseline, level, greenSinceMs, Date.now(), alertSetSettled())',
    to: '      && isRestartRecovery(continuationBaseline, level, greenSinceMs, Date.now(), true) /* MUTANT */',
    why: 'A green read before a feed has delivered is spoken as an all-clear (the boot false-green).',
  },
  {
    id: 'B-iii. ★★★ the predicate ignores the settled flag',
    file: BR,
    find: '  if (!alertSetSettled) return false;',
    to: '  /* MUTANT */',
    why: 'As B-ii.',
  },
  {
    id: 'B-iv. ★★ the predicate does not require the dwell',
    file: BR,
    find: '  return greenSinceMs != null && nowMs - greenSinceMs >= dwellMs;',
    to: '  return greenSinceMs != null; /* MUTANT */',
    why: 'The predicate no longer says the green stood its dwell (the tick holds it, but the rule is stated here).',
  },
  {
    id: 'B-v. ★★ the dwell bound is exclusive',
    file: BR,
    find: '  return greenSinceMs != null && nowMs - greenSinceMs >= dwellMs;',
    to: '  return greenSinceMs != null && nowMs - greenSinceMs > dwellMs; /* MUTANT */',
    why: 'Off by one against the de-escalation dwell it shares.',
  },
  {
    id: 'B-vi. ★★★ a yellow can be a recovery',
    file: BR,
    find: "  if (observed !== 'green') return false;\n  if (baseline == null) return false;",
    to: "  if (observed === 'red') return false; /* MUTANT */\n  if (baseline == null) return false;",
    why: 'A yellow under a heard red would be re-spoken as a recovery; yellow continuation is unchanged by design.',
  },
  {
    id: 'B-vii. ★★ no heard baseline is required',
    file: BR,
    find: '  if (baseline == null) return false;\n  if (!alertSetSettled) return false;',
    to: '  /* MUTANT */\n  if (!alertSetSettled) return false;',
    why: 'The predicate claims a recovery where nothing was heard before the restart.',
  },
  {
    id: 'B-viii. ★★★ the baseline does not end with the recovery',
    file: BR,
    find: '      continuationBaseline = null;',
    to: '      /* MUTANT */',
    why: 'A new warning after the spoken all-clear is filed as a continuation and never spoken.',
  },
  {
    id: 'B-ix. ★★★ the continuation still reads the boot baseline',
    file: BR,
    find: '    if (transitioned && isRestartContinuation(continuationBaseline, level, Date.now() - bootMs)) {',
    to: '    if (transitioned && isRestartContinuation(bootBaselineLevel, level, Date.now() - bootMs)) { /* MUTANT */',
    why: 'The recovery is logged but the green is still adopted in silence.',
  },
  {
    id: 'B-x. ★★ the recovery is decided outside the warm-up',
    file: BR,
    find: '      transitioned && continuationBaseline != null && Date.now() - bootMs < BROADCAST_BOOT_WARMUP_MS',
    to: '      transitioned && continuationBaseline != null /* MUTANT */',
    why: 'A routine green long after boot is logged as a restart recovery.',
  },
  {
    id: 'B-xi. ★★ an absent settled reader reads as settled',
    file: BR,
    find: '    try { return opts.alertSetSettled?.() === true; } catch { return false; }',
    to: '    try { return opts.alertSetSettled?.() !== false; } catch { return false; } /* MUTANT */',
    why: 'A monitor not wired to the store and feeds speaks a green it cannot vouch for.',
  },
  {
    id: 'B-xii. ★★ a throwing settled reader reads as settled',
    file: BR,
    find: '    try { return opts.alertSetSettled?.() === true; } catch { return false; }',
    to: '    try { return opts.alertSetSettled?.() === true; } catch { return true; } /* MUTANT */',
    why: 'An unreadable feed state is taken as settled.',
  },
  {
    id: 'B-xiii. ★★★ production: the feeds are not consulted',
    file: IX,
    find: '  alertSetSettled: () => store.firstPollSettledAt > 0 && monitor.stats().alertFeeds.every((f) => f.warm),',
    to: '  alertSetSettled: () => store.firstPollSettledAt > 0, /* MUTANT */',
    why: 'A green read before a worker feed has delivered once is spoken as an all-clear.',
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
console.log(`mutate-v1187-3h: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
