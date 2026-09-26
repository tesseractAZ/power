#!/usr/bin/env node
/**
 * mutate-alert-monitor.mjs — committed harness for v1.186.0: the auto-tune rollups count
 * annunciating alerts only (a bench spare's volume no longer demotes a home Core's push, the
 * pre-scope log lines are not replayed, a latch is judged at the pushed alert's own tier, and
 * every suppressed or demoted push names its rule), and the alarm tick no longer waits on the
 * analytics worker (live alarms publish first, worker-served alerts carry their last good
 * value under a short budget, the feature snapshot runs off the dispatch path), and the boot
 * sequencing that publish-first requires (the first evaluation waits for a hydrated store, bounded;
 * the broadcast's first tick never joins a non-green level silently; the worker's first-snapshot
 * gate opens on projections; the cold-feed holds are scoped to the ids a cold feed owns; the
 * alarm counts wait for a complete set).
 *
 *   node scripts/mutate-alert-monitor.mjs
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
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const AC = resolve(SERVER, 'src/analyticsClient.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const PR = resolve(SERVER, 'src/publishReadiness.ts');

const SUBSET = [
  'test/alertMonitorScopeAndFeeds.test.ts',
  'test/bootSequencing.test.ts',          // v1.186.0 boot sequencing
  'test/analyticsWorker.test.ts',
  'test/publishReadiness.test.ts',
  'test/restartIntegrity.test.ts',
];

const MUTANTS = [
  {
    id: 'i. ★★★ a muted alert feeds the rise side of the rollup again',
    file: AM,
    find: '        const counts = autoTuneCounts(a);',
    to: '        const counts = true; /* MUTANT */',
    why: 'A bench spare\'s churn counts toward Rule 4 and demotes every home-Core vdiff-warn push to [Low].',
  },
  {
    id: 'ii. ★★ a muted episode lands its clear in the rollup again',
    file: AM,
    find: '      if (autoTuneClearCounts(t)) recordClear(t.alert, duration, nowMs);',
    to: '      recordClear(t.alert, duration, nowMs); /* MUTANT */',
    why: 'Off-panel and bench-spare clears move the home family\'s short-clear fraction toward Rules 1 and 2.',
  },
  {
    id: 'iii. ★ a boot re-track counts its clear even when it ended muted',
    file: AM,
    find: '  return t.rollupScope === \'retrack\' && t.alert.annunciate !== false;',
    to: '  return t.rollupScope === \'retrack\'; /* MUTANT */',
    why: 'An off-panel Core (demoted three ticks after boot) lands a clear in the home family on every restart.',
  },
  {
    id: 'iv. ★★★ the pre-scope log lines are replayed again',
    file: AM,
    find: '    if (e.scope !== TELEMETRY_SCOPE_ANNUNCIATING && opts.includeLegacy !== true) {',
    to: '    if (false /* MUTANT */) {',
    why: 'The spare-driven vdiff-warn demotion and peer-voldiff silence survive the upgrade for 30 days.',
  },
  {
    id: 'v. ★★ a new rise line is written without its scope',
    file: AM,
    find: 'event: \'rise\', ts, scope: TELEMETRY_SCOPE_ANNUNCIATING });',
    to: 'event: \'rise\', ts }); /* MUTANT */',
    why: 'The next boot declines the line as legacy, so the auto-tune never learns from annunciating evidence.',
  },
  {
    id: 'vi. ★★★ a push is judged at the family exemplar\'s tier again',
    file: AM,
    find: '  const ratedAt = moreSevere(alert.severity, t.severity);',
    to: '  const ratedAt = t.severity; /* MUTANT */',
    why: 'An info-derived silence eats a WARNING member with no push (the 09-23 peer-voldiff drop).',
  },
  {
    id: 'vii. ★★ an auto-tune suppression is silent again',
    file: AM,
    find: '      log(`notify: ${kind === \'resolved\' ? \'resolve \' : \'\'}suppressed "${subject}" (${alert.severity}) — auto-tune ',
    to: '      /* MUTANT */ void (`notify: ${kind === \'resolved\' ? \'resolve \' : \'\'}suppressed "${subject}" (${alert.severity}) — auto-tune ',
    why: 'A dropped push leaves no line, indistinguishable from one never evaluated.',
  },
  {
    id: 'viii. ★ a demoted push no longer names its rule and counts',
    file: AM,
    find: ' via auto-tune — ${verdict.rule} on family "${t?.familyKey}": ${verdict.basis})',
    to: ' via auto-tune /* MUTANT */)',
    why: 'A "[Low]" push cannot be traced to the rollup that demoted it.',
  },
  {
    id: 'ix. ★★★ a timed-out worker report reads as "no alerts" again',
    file: AM,
    find: '      return { value: last != null ? clone(last.value) : null, fresh, firstDelivery, ageMs, error };',
    to: '      return { value: fresh && last != null ? clone(last.value) : null, fresh, firstDelivery, ageMs, error }; /* MUTANT */',
    why: 'A worker stall resolves every worker-served alert: false "Resolved:" pushes, then a re-raise.',
  },
  {
    id: 'x. ★★★ the tick waits on the worker without a budget',
    file: AM,
    find: '          timer = setTimeout(() => res(\'budget\'), budgetMs);',
    to: '          timer = setTimeout(() => res(\'budget\'), 2_000_000_000); /* MUTANT */',
    why: 'A hung worker freezes dispatch and every later tick (30 s + 30 s retry per report, or forever).',
  },
  {
    id: 'xi. ★★ a carried value is shared, not copied',
    file: AM,
    find: '    try { return structuredClone(v); } catch { return v; }',
    to: '    return v; /* MUTANT */',
    why: 'An off-panel mute stamped on one tick persists into the next: a Core re-armed on the roster stays silent.',
  },
  {
    id: 'xii. ★★★ the live alarms wait for the worker before they publish',
    file: AM,
    find: '    publish(assemble(workerDerived({',
    to: '    void (assemble(workerDerived({ /* MUTANT */',
    why: 'Offline, blind, reserve and thermal alarms reach the screen and the broadcast only after the budget.',
  },
  {
    id: 'xiii. ★★ the feature snapshot blocks the tick again',
    file: AM,
    find: '    for (const a of featureCaptures) void captureFeaturesDetached(a, snap, now);',
    to: '    for (const a of featureCaptures) await captureFeaturesDetached(a, snap, now); /* MUTANT */',
    why: 'Four worker reports per new alert hold the evaluate latch: 47-73 s of frozen dispatch after a boot.',
  },
  {
    id: 'xiv. ★★ a cold feed lets tick 1 prune the pre-restart onsets',
    file: AM,
    find: '    alertFeedOwning(id) != null ? !coldFeedOwns(id) : storeHydrated();',
    to: '    alertFeedOwning(id) != null ? true /* MUTANT */ : storeHydrated();',
    why: 'A worker-served condition that predates the restart re-rises on first delivery: a phantom rise and a re-push.',
  },
  {
    id: 'xv. ★★ a feed\'s first delivery is not treated as its first run',
    file: AM,
    find: 'firstRun, firstFeedDelivery: firstDeliveryIds.has(a.id) || lateHydrationPass, priorOnsetMs',
    to: 'firstRun, firstFeedDelivery: lateHydrationPass /* MUTANT */, priorOnsetMs',
    why: 'Every standing worker-served alert counts a rise and re-pushes after each deploy.',
  },
  {
    id: 'xvi. ★★ the boot orphan sweep resolves while a feed is cold',
    file: AM,
    find: '        unevaluable: (id, rec) => coldFeedOwns(id) || fallingEdgeFrozenByEvidence({',
    to: '        unevaluable: (id, rec) => /* MUTANT */ fallingEdgeFrozenByEvidence({',
    why: 'A pushed worker-served alert gets "Resolved: … cleared while the add-on was restarting" on no evidence.',
  },
  // ── v1.186.0 boot sequencing ──
  {
    id: 'xvii. ★★★ the first evaluation runs on an unhydrated store again',
    file: AM,
    find: '    if (!openBootGate()) return;',
    to: '    /* MUTANT */',
    why: 'Tick 1 seeds and publishes a pre-poll set: standing alarms rise as phantoms on tick 2, a phantom "cloud session stale" is published, and the broadcast joins a partial set.',
  },
  {
    id: 'xviii. ★★★ a cloud outage at boot holds every alarm (no bound)',
    file: AM,
    find: '    if (hydrationBoundReached || Date.now() - monitorStartMs >= hydrationMaxMs) {',
    to: '    if (false /* MUTANT */) {',
    why: 'With no complete poll, the offline and telemetry-blind alarms never evaluate at all.',
  },
  {
    id: 'xix. ★★ the first pass after a late hydration counts standing alarms as rises',
    file: AM,
    find: 'firstRun, firstFeedDelivery: firstDeliveryIds.has(a.id) || lateHydrationPass, priorOnsetMs',
    to: 'firstRun, firstFeedDelivery: firstDeliveryIds.has(a.id) /* MUTANT */, priorOnsetMs',
    why: 'After a boot into a cloud outage, every pre-restart condition the first poll brings in is a phantom rise and a re-push.',
  },
  {
    id: 'xx. ★★ a live id\'s onset is pruned before the store is hydrated',
    file: AM,
    find: '    alertFeedOwning(id) != null ? !coldFeedOwns(id) : storeHydrated();',
    to: '    alertFeedOwning(id) != null ? !coldFeedOwns(id) : true /* MUTANT */;',
    why: 'A bound-opened first pass on an empty map erases every standing alarm\'s true onset (the v1.130.0 truncation).',
  },
  {
    id: 'xxi. ★★ the boot orphan sweep holds EVERY id while any feed is cold again',
    file: AM,
    find: '        unevaluable: (id, rec) => coldFeedOwns(id) || fallingEdgeFrozenByEvidence({',
    to: '        unevaluable: (id, rec) => !alertFeedsWarm() /* MUTANT */ || fallingEdgeFrozenByEvidence({',
    why: 'A wedged worker holds a cleared offline/vdiff alarm for 6 h and then drops its "Resolved:" silently.',
  },
  {
    id: 'xxii. ★★ the alarm counts publish from a set with a cold feed',
    file: AM,
    find: 'if (!alertsCompleteMarked && ((storeHydrated() && alertFeedsWarm()) || Date.now() - monitorStartMs >= ALERT_COUNTS_READY_MAX_MS)) {',
    to: 'if (!alertsCompleteMarked && (true /* MUTANT */ || Date.now() - monitorStartMs >= ALERT_COUNTS_READY_MAX_MS)) {',
    why: 'The learned and priority counts go X → 0 → X across every restart (the v1.178.0 dip).',
  },
  {
    id: 'xxiii. ★★★ the broadcast joins a non-green first tick silently again',
    file: BC,
    find: '      if (level === \'green\') {',
    to: '      if (true /* MUTANT */) {',
    why: 'A condition standing at boot and never heard before the restart is never spoken, nor pushed.',
  },
  {
    id: 'xxiv. ★★ the first-snapshot gate opens on the device list again',
    file: AC,
    find: '  !!s && Object.values(s.devices ?? {}).some((d) => d?.projection != null);',
    to: '  !!s && Object.keys(s.devices ?? {}).length > 0; /* MUTANT */',
    why: 'Each alert feed\'s one-shot first delivery is computed on a projection-less map and spent on [].',
  },
  {
    id: 'xxv. ★★ the hydrated map is not flushed to the worker',
    file: AC,
    find: '    flushSnapshot: () => { if (snapHasProjections(lastSnapshot)) { postSnapshot(); openGate(); } },',
    to: '    flushSnapshot: () => { /* MUTANT */ },',
    why: 'The first reports run on the first quota\'s partial map: the other Cores\' standing worker alerts rise later.',
  },
  {
    id: 'xxvi. ★★ refreshAll never marks the store hydrated',
    file: SNAP,
    find: '  store.markFirstPollSettled();',
    to: '  /* MUTANT */',
    why: 'Every boot waits out the full bound before the first alarm evaluation.',
  },
  {
    id: 'xxvii. ★★ the alarm counts are ready the moment any set exists',
    file: PR,
    find: '    alerts: i.alerts !== undefined && i.alertsComplete === true,',
    to: '    alerts: i.alerts !== undefined, /* MUTANT */',
    why: 'HA alarm counts publish from the first (live-only) set: a false 0 in alert_critical_count at a restart.',
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
console.log(`mutate-alert-monitor: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
