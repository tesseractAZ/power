#!/usr/bin/env node
/**
 * mutate-detector-honesty.mjs — committed mutation harness for the v1.131.0
 * batch: five signals that were published without being earned.
 *
 * WHY COMMITTED: every defect in this batch is of the same family — a detector
 * or a status field that CANNOT report the thing it claims to report, and whose
 * silence is indistinguishable from health. Three of the five had been shipping
 * that way since the feature was written. "The tests would catch a regression"
 * is exactly the claim that has to be demonstrated here rather than asserted.
 *
 *   node scripts/mutate-detector-honesty.mjs
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
const ANALYTICS = resolve(SERVER, 'src/analytics.ts');
const MONITOR = resolve(SERVER, 'src/alertMonitor.ts');
const ACTUATOR = resolve(SERVER, 'src/nightChargeActuator.ts');
const RATEFLOOR = resolve(SERVER, 'src/messageRateFloor.ts');
const NOTIFY = resolve(SERVER, 'src/notify.ts');

const SUBSET = ['test/detectorHonesty.test.ts', 'test/nightChargeActuator.test.ts'];

const MUTANTS = [
  /* ── 1. the inverter-standby detector ─────────────────────────────────── */
  {
    id: 'i. ★ the whole-house load gate comes back (the original defect)',
    file: ANALYTICS,
    find: "  return p.pvW < INVERTER_IDLE_PV_DARK_W\n    && p.acOutW > 0\n    && p.acOutW < INVERTER_IDLE_AC_MAX_W;",
    to: "  return false; /* MUTANT: the pre-v1.131.0 gate, which no occupied house satisfied */",
    why: 'This IS the shipped defect: every DPU reports idleWatts:null forever and the card reads as "nothing to report".',
  },
  {
    id: 'ii. PV-dark condition dropped (daytime AC-out counted as standby)',
    file: ANALYTICS,
    find: '  return p.pvW < INVERTER_IDLE_PV_DARK_W\n',
    to: '  return true\n', // eslint-disable-line -- MUTANT
    why: 'Midday samples would enter the floor and the trend would track sunlight, not the inverter.',
  },
  {
    id: 'iii. the standby window loses its upper bound',
    file: ANALYTICS,
    find: '    && p.acOutW < INVERTER_IDLE_AC_MAX_W;',
    to: '    && p.acOutW < Infinity; /* MUTANT */',
    why: 'Real household load would be reported as inverter overhead.',
  },
  {
    id: 'iv. the floor becomes the median again',
    file: ANALYTICS,
    find: '  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];',
    to: '  return sorted[Math.floor(sorted.length / 2)]; /* MUTANT */',
    why: 'Without the whole-house gate the window admits real load; a median publishes THAT, not standby.',
  },
  {
    id: 'v. thin nights contribute a floor built from noise',
    file: ANALYTICS,
    find: '    if (watts.length < minPerDay) continue;',
    to: '    /* MUTANT */',
    why: 'One stray sample would become a whole day\'s floor and steer the trend.',
  },

  {
    id: 'va. ★ the empty state goes silent again (v1.131.1)',
    file: ANALYTICS,
    find: '  if (idleCount >= minSamples) return null;\n  if (aoValues.length === 0) return \'no-ac-out-history\';',
    to: '  return null; /* MUTANT */\n  if (aoValues.length === 0) return \'no-ac-out-history\';',
    why: 'A blank standby row reads exactly like a healthy one — which is how this detector hid for its whole life.',
  },
  {
    id: 'vb. a dead AC-output stage is misreported as thin data',
    file: ANALYTICS,
    find: "  if (aoValues.every((v) => v === 0)) return 'ac-output-stage-idle';",
    to: "  /* MUTANT */",
    why: 'The operator would wait for samples that can never arrive on this topology.',
  },

  /* ── 2. the alert-telemetry exemplar ──────────────────────────────────── */
  {
    id: 'vi. ★ the exemplar id stops following the title it belongs to',
    file: MONITOR,
    find: "  if (meta?.alertId) return { alertId: meta.alertId, title: meta.title ?? familyKey, pinned: true };",
    to: "  if (meta?.alertId) return { alertId: eventAlertId, title: meta.title ?? familyKey, pinned: true }; /* MUTANT */",
    why: 'This IS the shipped defect: /api/alert-telemetry publishes one device\'s title beside another\'s id.',
  },
  {
    id: 'vii. a pre-v1.131.0 sidecar is treated as authoritative anyway',
    file: MONITOR,
    find: "  return { alertId: eventAlertId, title: meta?.title ?? familyKey, pinned: false };",
    to: "  return { alertId: eventAlertId, title: meta?.title ?? familyKey, pinned: true }; /* MUTANT */",
    why: 'Pinning an event-derived id freezes it on the FIRST event instead of the most recent member.',
  },
  {
    id: 'viii. the sidecar stops persisting the id it was written with',
    file: MONITOR,
    find: "  return { title: alert.title, severity: alert.severity, category: alert.category, alertId: alert.id };",
    to: "  return { title: alert.title, severity: alert.severity, category: alert.category }; /* MUTANT */",
    why: 'The tuple splits again at the next restart — three fields restored coherently, the fourth guessed.',
  },

  /* ── 3. the night-charge revert readback ──────────────────────────────── */
  {
    id: 'ix. ★ the revert closes on the cloud ACK again (the v1.79.0 defect, mirrored)',
    file: ACTUATOR,
    find: '    if (opts.currentReservePct === restorePct) return { kind: \'revertVerified\' };',
    to: '    return { kind: \'none\' }; /* MUTANT */',
    why: 'A restore the panel ignores leaves the reserve pinned raised, buying grid at on-peak, with the ledger reading a clean night.',
  },
  {
    id: 'x. the failure verdict stops requiring the RAISED reading',
    file: ACTUATOR,
    find: '      opts.currentReservePct === state.targetPct && state.targetPct !== restorePct &&',
    to: '      state.targetPct !== restorePct &&  /* MUTANT */',
    why: 'An owner who moved the floor themselves after the revert would have our restore written over their change.',
  },
  {
    id: 'xi. the settling window is ignored',
    file: ACTUATOR,
    find: '      nowMs - attemptedAt >= REVERT_VERIFY_AFTER_MS',
    to: '      nowMs >= attemptedAt  /* MUTANT */',
    why: 'A verdict inside the 20-60 s projection lag fights isRevertSettling and re-writes a restore that DID land.',
  },
  {
    id: 'xii. retries are uncapped (never escalates to the operator)',
    file: ACTUATOR,
    find: '      if (state.revertRetries < REVERT_MAX_RETRIES) return { kind: \'retryRevert\', restorePct };',
    to: '      return { kind: \'retryRevert\', restorePct }; /* MUTANT */',
    why: 'The reserve stays stuck and nobody is ever told; the system retries a write the panel is refusing.',
  },
  // A mutant that turns the readback block's fall-through into `return none`
  // was written, run, and REMOVED as equivalent: the APPLY branch immediately
  // below refuses any state with a non-null appliedAtMs, which every state
  // reaching that block has, so the return changes nothing observable. Keeping
  // it would have reported a permanent survivor for a behaviour no test can
  // distinguish. Do not re-add it without first making the fall-through
  // load-bearing.

  /* ── 4. the rate-floor sample set ─────────────────────────────────────── */
  {
    id: 'xiv. ★ the collapse detector iterates the ingest map again',
    file: RATEFLOOR,
    find: '  for (const sn of rosterSns) {\n    seen.add(sn);\n    out.push({ sn, count: counts.get(sn) ?? 0 });\n  }',
    to: '  /* MUTANT */',
    why: 'This IS the shipped defect: a device that has never spoken is absent from the map, so total silence was invisible.',
  },
  {
    id: 'xv. a device that left the roster stops being watched',
    file: RATEFLOOR,
    find: '  for (const [sn, count] of counts) {\n    if (!seen.has(sn)) out.push({ sn, count });\n  }',
    to: '  /* MUTANT */',
    why: 'A mid-run roster change would silently drop a device out of collapse monitoring.',
  },

  /* ── 5. push-channel health ───────────────────────────────────────────── */
  {
    id: 'xvi. ★ the failure record moves back after the throw',
    file: NOTIFY,
    find: '  lastPushFailures = failures;\n  if (targets.length > 0 && failures.length === targets.length) {',
    to: '  if (targets.length > 0 && failures.length === targets.length) {',
    why: 'This IS the shipped defect: with one target, a completely dead push channel reported an empty failure list.',
  },
  {
    id: 'xvii. a dead push channel stops throwing',
    file: NOTIFY,
    find: '    throw new Error(`HA push failed on all ${failures.length} target(s): ${failures.join(\'; \')}`);',
    to: '    /* MUTANT */',
    why: 'The caller would mark the alert notified and never retry — the v0.80.0 silent-eat, reintroduced.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-detector-honesty: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
    if (!died) { try { run([]); } catch { died = true; } } // confirm against the FULL suite
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
