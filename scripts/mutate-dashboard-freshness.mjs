#!/usr/bin/env node
/**
 * mutate-dashboard-freshness.mjs — committed harness for the v1.176.0 freshness signals
 * (web/src/freshness.ts, usePolled.ts, App.tsx header + pill, RunwayCard, TodaySummary,
 * AdvancedInsightsCard).
 *
 * WHY COMMITTED: a freshness signal that fails, fails GREEN. Every mutant below leaves the
 * dashboard looking healthy while its data is not — the LIVE pill over an eleven-minute
 * outage, an "updated 0s ago" refreshed by poll failures, yesterday's totals under
 * "since 12:00 AM". Nothing crashes and no alarm fires; the operator simply trusts
 * numbers that are no longer true.
 *
 *   node scripts/mutate-dashboard-freshness.mjs
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
const FRESH = resolve(REPO, 'web/src/freshness.ts');
const HOOK = resolve(REPO, 'web/src/usePolled.ts');
const APP = resolve(REPO, 'web/src/App.tsx');
const TODAY = resolve(REPO, 'web/src/cards/TodaySummary.tsx');

const SUBSET = ['test/dashboardFreshness.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the pill ignores reading age \u2014 an open socket is LIVE again',
    file: FRESH,
    find: "  if (oldest == null || nowMs - oldest > TELEMETRY_STALE_MS) return 'stale';",
    to: '  /* MUTANT */',
    why: 'LIVE stays green through a cloud outage: the 2026-09-22 03:17-03:28 picture, eleven minutes of stale figures under a green pill.',
  },
  {
    id: 'ii. \u2605\u2605 the NEWEST reading decides, not the oldest',
    file: FRESH,
    find: '    if (t < oldest) oldest = t;',
    to: '    if (oldest === Infinity || t > oldest) oldest = t; /* MUTANT */',
    why: 'Cores streaming every second hide a panel that went quiet: the Loads figure is minutes old under a LIVE pill.',
  },
  {
    id: 'iii. \u2605\u2605 bench and accessory devices count as home',
    file: FRESH,
    find: '    return connected.size > 0 ? isShp2Connected(d.sn, connected) : d.online;',
    to: '    return true; /* MUTANT */',
    why: 'A bench Core that last reported hours ago pins the pill at STALE forever; the operator learns to ignore it.',
  },
  {
    id: 'iv. \u2605 a never-reported home device is skipped instead of making the data stale',
    file: FRESH,
    find: '    if (!(t > 0)) return null;',
    to: '    if (!(t > 0)) continue; /* MUTANT */',
    why: 'A Core that has not reported since boot shows blanks, and the pill calls the dashboard LIVE.',
  },
  {
    id: 'v. \u2605\u2605 the stale threshold is three hours',
    file: FRESH,
    find: 'export const TELEMETRY_STALE_MS = 3 * 60_000;',
    to: 'export const TELEMETRY_STALE_MS = 3 * 60 * 60_000; /* MUTANT */',
    why: 'The pill disagrees with the alarm engine by two orders of magnitude; an outage never turns it amber.',
  },
  {
    id: 'vi. \u2605 a polled card may miss a thousand polls before it is stale',
    file: FRESH,
    find: 'export const POLL_STALE_MISSES = 2.5;',
    to: 'export const POLL_STALE_MISSES = 1000; /* MUTANT */',
    why: 'Runway and Today keep presenting a payload from the previous day as current.',
  },
  {
    id: 'vii. \u2605\u2605 yesterday\u2019s day window is still today until 48 h',
    file: FRESH,
    find: '  return sinceMs != null && nowMs - sinceMs >= 24 * 3_600_000;',
    to: '  return sinceMs != null && nowMs - sinceMs >= 48 * 3_600_000; /* MUTANT */',
    why: 'After midnight the Today card shows yesterday\u2019s totals under "since 12:00 AM".',
  },
  {
    id: 'viii. \u2605\u2605\u2605 the header age is read from generatedAt again',
    file: APP,
    find: '              updated {fmtRel(oldestReading, now)}',
    to: '              updated {fmtRel(snapshot?.generatedAt ?? null, now)} {/* MUTANT */}',
    why: 'Every failed cloud poll refreshes the header to "0s ago" \u2014 the harder the cloud fails, the fresher it looks.',
  },
  {
    id: 'ix. \u2605\u2605 the header clock does not tick',
    file: APP,
    find: '  const now = useNow(5_000);',
    to: '  const now = Date.now(); /* MUTANT */',
    why: 'With the pipe silent nothing re-renders, and the header freezes at the last age it printed.',
  },
  {
    id: 'x. \u2605\u2605\u2605 Today renders an expired day\u2019s payload',
    file: TODAY,
    find: '  const data = polled.data && !dayWindowExpired(polled.data.sinceMs, now) ? polled.data : null;',
    to: '  const data = polled.data; /* MUTANT */',
    why: 'Yesterday\u2019s solar, load and battery totals are presented as today\u2019s.',
  },
  {
    id: 'xi. \u2605\u2605 the shared poller treats an HTTP error body as data',
    file: HOOK,
    find: '        if (!r.ok) {\n          setState((s) => ({ ...s, failing: true }));\n          return;\n        }',
    to: '        /* MUTANT */',
    why: 'A 500 response replaces the last good payload with `{ error: ... }` and resets the staleness clock as if it were fresh.',
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
console.log(`mutate-dashboard-freshness: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
