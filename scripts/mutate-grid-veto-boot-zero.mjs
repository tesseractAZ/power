#!/usr/bin/env node
/**
 * mutate-grid-veto-boot-zero.mjs — committed harness for v1.178.0: the grid resolver's
 * measured-absent veto (server/src/gridState.ts) and the publish-readiness rule that keeps
 * model-less zeros out of Home Assistant (server/src/publishReadiness.ts, both publishers,
 * the carbon/tariff/forecast basis flags in analytics.ts).
 *
 * WHY COMMITTED: both failures are silent. A declared grid that outranks the panel's own
 * "grid not detected" mutes the runway alarm through a real outage and nothing errors. A
 * boot-time 0 published as a reading looks like data — and on a total_increasing sensor it
 * is booked by Home Assistant as a meter reset, counting the day's energy again.
 *
 *   node scripts/mutate-grid-veto-boot-zero.mjs
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
const GRID = resolve(SERVER, 'src/gridState.ts');
const READY = resolve(SERVER, 'src/publishReadiness.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const MQTT = resolve(SERVER, 'src/mqttDiscovery.ts');

const SUBSET = ['test/gridMeasuredAbsentVeto.test.ts', 'test/publishReadiness.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 a declared grid outranks the panel\u2019s "grid not detected" again',
    file: GRID,
    find: '  const declared = declaredRaw && !gridMeasuredAbsent;',
    to: '  const declared = declaredRaw; /* MUTANT */',
    why: 'A grid toggle left ON through a surprise outage keeps the runway audible gated silent until the pool nears the floor.',
  },
  {
    id: 'ii. \u2605\u2605 an UNKNOWN panel reading (offline / shadowed / absent) vetoes the declaration',
    file: GRID,
    find: '  const gridMeasuredAbsent = shp2GridConnected === false;',
    to: '  const gridMeasuredAbsent = shp2GridConnected !== true; /* MUTANT */',
    why: 'Every panel cloud blip withdraws the backstop: nuisance runway alarms and off_grid flapping with the grid perfectly fine.',
  },
  {
    id: 'iii. \u2605 the veto reason is lost',
    file: GRID,
    find: '        : declaredRaw && gridMeasuredAbsent',
    to: '        : false /* MUTANT */',
    why: 'The resolver\u2019s reason says the grid entity is off when the toggle is ON and the panel measured no grid \u2014 misdirecting the investigation.',
  },
  {
    id: 'iv. \u2605\u2605\u2605 withholdUnready withholds nothing',
    file: READY,
    find: '    if (r[flag]) continue;',
    to: '    continue; /* MUTANT */',
    why: 'Every restart publishes a model-less 0 to 16 sensors again, and a meter reset on the total_increasing curtailment counter.',
  },
  {
    id: 'v. \u2605\u2605 alarm counts publish before the monitor has run',
    file: READY,
    find: '    alerts: i.alerts !== undefined,',
    to: '    alerts: true, /* MUTANT */',
    why: 'A fake "all clear" (0 alarms) for ~75 s after every restart, for any automation keyed on the counts.',
  },
  {
    id: 'vi. \u2605\u2605\u2605 the curtailment counters publish from the empty report',
    file: READY,
    find: "    curtailment: !!i.curtailment && i.curtailment.inactiveReason !== 'no-home-dpus' && i.curtailment.inactiveReason !== 'no-shp2',",
    to: '    curtailment: !!i.curtailment, /* MUTANT */',
    why: 'pv_curtailment_kwh_today (total_increasing) dips to 0 at boot: Home Assistant books a reset and counts the day again.',
  },
  {
    id: 'vii. \u2605\u2605 fleet flows publish before any Core is projected',
    file: READY,
    find: "    flow: devs.some((d) => d.online && d.projection?.kind === 'dpu'),",
    to: '    flow: devs.length > 0, /* MUTANT */',
    why: 'Fleet PV and battery net read 0 W at boot \u2014 the Energy dashboard\u2019s solar and battery rates notch to zero.',
  },
  {
    id: 'viii. \u2605\u2605 a silent panel publishes 0 W house load',
    file: READY,
    find: '    panel: !!panel && (panel.projection?.circuits ?? []).some((c) => c.watts != null),',
    to: '    panel: !!panel, /* MUTANT */',
    why: 'A panel that reported no channel reads as a house drawing nothing.',
  },
  {
    id: 'ix. \u2605 the carbon report does not expose its completeness',
    file: AN,
    find: '  value.basisComplete = fleetComplete;',
    to: '  /* MUTANT */',
    why: 'The 7-day CO2 figure computed on an empty snapshot publishes as a real 0.',
  },
  {
    id: 'x. \u2605 the tariff report claims completeness on a partial snapshot',
    file: AN,
    find: '  value.basisComplete = dpus.length > 0 && shp2 != null;',
    to: '  value.basisComplete = true; /* MUTANT */',
    why: 'Boot-partial grid cost / solar value / net savings publish as real figures and are cached for the full TTL.',
  },
  {
    id: 'xi. \u2605\u2605 the forecast never flags a model-less PV forecast',
    file: AN,
    find: '  value.pvForecastUnavailable = homeDpus.length === 0 || pvSpan === 0;',
    to: '  value.pvForecastUnavailable = false; /* MUTANT */',
    why: 'The boot forecast\u2019s 0 kWh is published to Home Assistant as a forecast, at every restart.',
  },
  {
    id: 'xii. \u2605\u2605 the REST twin is not passed through the readiness rule',
    file: IDX,
    find: '  withholdUnready(payload as Record<string, unknown>, publishReadiness({',
    to: '  ((_p: unknown, _r: unknown) => _p)(payload as Record<string, unknown>, publishReadiness({ /* MUTANT */',
    why: '/api/ha-state (Lovelace cards, REST sensors) keeps serving the boot zeros MQTT no longer publishes.',
  },
  {
    id: 'xiii. \u2605\u2605 the MQTT publisher is not passed through the readiness rule',
    file: MQTT,
    find: '    return withholdUnready(state, publishReadiness({',
    to: '    return ((s: Record<string, unknown>, _r: unknown) => s)(state, publishReadiness({ /* MUTANT */',
    why: 'The rule exists, is tested, and the publisher that caused the boot zeros ignores it.',
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
console.log(`mutate-grid-veto-boot-zero: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
