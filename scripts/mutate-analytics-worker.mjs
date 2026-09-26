#!/usr/bin/env node
/**
 * mutate-analytics-worker.mjs — committed harness for v1.186.0: the analytics worker
 * single-flights its reports (a timed-out retry joins the running scan), yields between warm
 * reports and between charge-curve slices, answers nothing before its first snapshot, and the
 * HA state publish settles each report on its own (bounded last-good, else null).
 *
 *   node scripts/mutate-analytics-worker.mjs
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
const REPORTS = resolve(SERVER, 'src/reports.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const CLIENT = resolve(SERVER, 'src/analyticsClient.ts');
const MQTT = resolve(SERVER, 'src/mqttDiscovery.ts');

const SUBSET = ['test/analyticsWorker.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a request for a report already computing starts its own scan',
    file: REPORTS,
    find: '      if (flying && t - flying.startedMs < maxJoinMs) return flying.p as Promise<T>;',
    to: '      void flying; /* MUTANT */',
    why: 'The warm loop, the HA publish and the client retry each run the full degradation scan on the one worker: the 6-of-7-boots timeout.',
  },
  {
    id: 'ii. ★★ a wedged flight is joined forever',
    file: REPORTS,
    find: 't - flying.startedMs < maxJoinMs',
    to: 'true /* MUTANT */',
    why: 'One promise that never settles silences that report (forecast, runway, the alert reports) for the life of the process.',
  },
  {
    id: 'iii. ★★ the slot is never freed',
    file: REPORTS,
    find: '        .finally(() => { if (flights.get(key)?.p === p) flights.delete(key); });',
    to: '        .finally(() => { /* MUTANT */ });',
    why: 'Every later request replays the first result (or the first rejection) of that report forever.',
  },
  {
    id: 'iv. ★★★ the warm pass runs its reports back to back again',
    file: REPORTS,
    find: '    await yieldTurn();',
    to: '    /* MUTANT */',
    why: 'Synchronous builders resume as microtasks; queued alarm-path requests wait for the whole 22-report pass.',
  },
  {
    id: 'v. ★★★ the charge-curve scan stops yielding between slices',
    file: AN,
    find: '    await new Promise<void>((r) => setImmediate(r));\n  }\n  return out;',
    to: '  }\n  return out; /* MUTANT */',
    why: 'The hourly recompute pins the worker 17-19 s again; an alert tick inside it waits, the next is dropped — ~40 s alarm latency.',
  },
  {
    id: 'vi. ★★ slices cut through 60 s buckets',
    file: AN,
    find: '    const hi = Math.min((Math.floor(lo / span) + 1) * span - 1, untilMs);',
    to: '    const hi = Math.min(lo + span - 1, untilMs); /* MUTANT */',
    why: 'A bucket split across two queries yields two half-averages under one timestamp: the fingerprint no longer matches the one-query scan.',
  },
  {
    id: 'vii. ★★★ a retry after a timeout drops the first attempt',
    file: CLIENT,
    find: "            log(`analytics: '${label}' timed out — retrying once`);",
    to: "            pending.delete(id); log(`analytics: '${label}' timed out — retrying once`); /* MUTANT */",
    why: 'The scan finishing just after 30 s is thrown away and the caller waits on a second attempt (13:00:22: it timed out too).',
  },
  {
    id: 'viii. ★★ a report reaches the worker before its first snapshot',
    file: CLIENT,
    find: '      const p = awaitFirstSnapshot()',
    to: '      const p = Promise.resolve() /* MUTANT */',
    why: 'The first evaluation and the connect-time publish compute on an empty device map, cached 20 s.',
  },
  {
    id: 'ix. ★★★ a failed report republishes its last value without bound',
    file: MQTT,
    find: '    out[name] = lg && now() - lg.atMs <= maxAgeMs ? lg.value : null;',
    to: '    out[name] = lg ? lg.value : null; /* MUTANT */',
    why: 'expire_after resets on every receipt: a dead report keeps its last runway on the HA dashboard as if live, forever.',
  },
  {
    id: 'x. ★★★ the state publish waits on its slowest report again',
    file: MQTT,
    find: '    const r = await Promise.race([answer, deadline]);',
    to: '    const r = await answer; void deadline; /* MUTANT */',
    why: 'One slow degradation scan withholds SoC, runway and the alarm counts from Home Assistant.',
  },
  {
    id: 'xi. ★★★ a missing runway publishes the 999 "no depletion" sentinel',
    file: MQTT,
    find: '      runway_to_reserve_hours: runway ? runwayHoursForPublish(runway.hoursToReserve, runway.unavailable) : null,',
    to: '      runway_to_reserve_hours: runwayHoursForPublish(runway?.hoursToReserve ?? null, runway?.unavailable ?? null), /* MUTANT */',
    why: 'Data loss reads as "plenty of runway" to every HA automation comparing runway < threshold.',
  },
  {
    id: 'xii. ★★ the lighting posture is computed without its reports',
    file: MQTT,
    find: '    const posture = runway && fc && curtailment',
    to: '    const posture = true /* MUTANT */',
    why: 'A missing runway either throws (the whole payload is lost again) or yields a calm posture nothing measured.',
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
console.log(`mutate-analytics-worker: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
