#!/usr/bin/env node
/**
 * mutate-telemetry-blind.mjs — committed mutation harness for the v1.69.0 blind-detection
 * and clock-offset signing (server/src/telemetryBlind.ts, server/src/ecoflow/clockOffset.ts,
 * and the learn-from-every-response seam in server/src/ecoflow/rest.ts).
 *
 * WHY COMMITTED: on 2026-08-04 the alarm system ran 22 minutes with zero telemetry while
 * /api/health returned ok:true, and NOTHING alerted. This code is the guard against that
 * happening silently again, so "the tests would catch a regression" has to be demonstrable
 * rather than asserted.
 *
 * Mutant `ix` is the one that matters most and the easiest to introduce by accident:
 * learning the clock offset only from SUCCESSFUL responses. That looks reasonable and is
 * completely wrong — the whole mechanism depends on reading the Date header off the 8521
 * REJECTION, because while the clock is skewed there are no successful responses to learn
 * from. A reviewer "tidying" that would silently restore the 22-minute outage.
 *
 *   node scripts/mutate-telemetry-blind.mjs
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
const BLIND = resolve(SERVER, 'src/telemetryBlind.ts');
const OFFSET = resolve(SERVER, 'src/ecoflow/clockOffset.ts');

const SUBSET = ['test/telemetryBlind.test.ts', 'test/clockOffset.test.ts'];

const MUTANTS = [
  {
    id: 'i. blindness judged on the device map ALONE (the leftover-map hole)',
    file: BLIND,
    find: '  if (hasDevices && pollFresh) return idle;',
    to: '  if (hasDevices) return idle; /* MUTANT */',
    why: 'Devices left over from before the outage would read as sight. This is exactly how it hid.',
  },
  {
    id: 'ii. boot grace ignored (false alarm on every cold start)',
    file: BLIND,
    find: '    if (sinceBoot < cfg.bootGraceMs) return idle;',
    to: '    /* MUTANT */',
    why: 'Every restart would raise a CRITICAL before the first poll could land.',
  },
  {
    id: 'iii. stale telemetry no longer counts as blind',
    file: BLIND,
    find: '  if (sincePollOk != null && sincePollOk >= cfg.staleMs) {',
    to: '  if (false) { /* MUTANT */',
    why: 'Losing telemetry after having it — the commonest failure — would go unreported.',
  },
  {
    id: 'iv. blind alert downgraded from critical',
    file: BLIND,
    find: "    severity: 'critical' as const,",
    to: "    severity: 'warning' as const, /* MUTANT */",
    why: 'The one condition where silence is dangerous would stop breaking through.',
  },
  {
    id: 'v. self-heal fires on NETWORK errors too',
    file: BLIND,
    find: "  if (kind !== 'auth') return false;",
    to: '  /* MUTANT */',
    why: 'Rebuilding the client into a dead network is churn, not recovery.',
  },
  {
    id: 'vi. self-heal cooldown removed (restart loop)',
    file: BLIND,
    find: '  if (i.lastHealAtMs != null && i.nowMs - i.lastHealAtMs < cfg.healCooldownMs) return false;',
    to: '  /* MUTANT */',
    why: 'A persistent fault would restart the client every tick forever.',
  },
  {
    id: 'vii. clock-offset deadband removed (adopts latency as skew)',
    file: OFFSET,
    find: '  if (Math.abs(measured - offsetMs) < OFFSET_DEADBAND_MS) {',
    to: '  if (false) { /* MUTANT */',
    why: 'Normal round-trip latency would rewrite the signing offset on every request.',
  },
  {
    id: 'viii. sanity limit removed (adopts an absurd header)',
    file: OFFSET,
    find: '  if (Math.abs(measured) > OFFSET_SANITY_LIMIT_MS) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A broken or proxied Date header would break signing that currently works.',
  },
  {
    id: 'ix. ★ signing ignores the learned offset (the fix becomes a silent no-op)',
    file: OFFSET,
    find: '  return localNowMs + offsetMs;',
    to: '  return localNowMs; /* MUTANT */',
    why: 'Everything still LOOKS wired — the offset is measured and logged — but signing is unchanged.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-telemetry-blind: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
