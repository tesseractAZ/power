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
const SNAP = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = ['test/gridMeasuredAbsentVeto.test.ts', 'test/publishReadiness.test.ts', 'test/curtailment.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 a declared grid outranks the panel\u2019s "grid not detected" again',
    file: GRID,
    find: '  const declared = declaredRaw && !gridMeasuredAbsent;',
    to: '  const declared = declaredRaw; /* MUTANT */',
    why: 'A grid toggle left ON through a surprise outage keeps the runway audible gated silent until the pool nears the floor.',
  },
  {
    id: 'ii. \u2605\u2605 a field the panel never reported vetoes the declaration',
    file: GRID,
    find: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false\n    || persistedAbsent != null;',
    to: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) !== true; /* MUTANT */',
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
    id: 'iii-b. \u2605\u2605\u2605 the veto reads the ONLINE-GATED value: a cloud shadow or a cloud-offline panel lifts it mid-outage',
    file: GRID,
    find: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false\n    || persistedAbsent != null;',
    to: '  const gridMeasuredAbsent = shp2GridConnected === false; /* MUTANT */',
    why: 'A cloud-replay shadow (2-4 a day) or an outage that also takes the ISP down republishes "grid present": off_grid falls, load_shed_recommended drops, the runway audible is re-gated.',
  },
  {
    id: 'iii-d. \u2605\u2605\u2605 the veto lapses on wall-clock AGE (the cloud going quiet mid-outage)',
    file: GRID,
    find: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false\n    || persistedAbsent != null;',
    to: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false && Date.now() - (panel?.lastQuotaAtMs ?? 0) <= 300_000; /* MUTANT */',
    why: 'Five minutes into an outage whose uplink also fails, the resolver republishes "grid present" and the runway audible is gated silent again.',
  },
  {
    id: 'iii-e. \u2605\u2605 the veto is set aside after an online transition (a 6 s /status blip lifts it for a poll)',
    file: GRID,
    find: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false\n    || persistedAbsent != null;',
    to: "  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false && !(typeof panel?.onlineChangedAtMs === 'number' && panel.onlineChangedAtMs > (panel?.lastQuotaAtMs ?? 0)); /* MUTANT */",
    why: 'Each blip mid-outage draws a false off_grid edge and can re-arm and repeat the runway announcement.',
  },
  {
    id: 'iii-f. \u2605\u2605 the veto ignores the last reply that carried gridSta (a partial reply lifts it)',
    file: GRID,
    find: '  const gridMeasuredAbsent = (panel?.projection.gridConnected ?? vetoPanel?.lastGridReading?.connected) === false\n    || persistedAbsent != null;',
    to: '  const gridMeasuredAbsent = panel?.projection.gridConnected === false; /* MUTANT */',
    why: 'A /quota/all reply without the pd303_mc subtree re-projects gridConnected as null: "grid present" for a poll, mid-outage.',
  },
  {
    id: 'iii-g. \u2605\u2605 the /device/list rebuild drops the last grid reading (the sticky-clock trap)',
    file: SNAP,
    find: '        lastGridReading: existing?.lastGridReading, // v1.178.0 — same trap, same carry',
    to: '        /* MUTANT */',
    why: 'Every 60 s rebuild forgets the reading the veto falls back to.',
  },
  {
    id: 'iii-h. \u2605 the latch takes a reply that carried no gridSta',
    file: SNAP,
    find: "    if (cur.projection?.kind === 'shp2' && cur.projection.gridConnected != null) {",
    to: "    if (cur.projection?.kind === 'shp2') { /* MUTANT */",
    why: 'A partial reply overwrites the last real reading with null.',
  },
  {
    id: 'iii-c. the reason says gridSta=0 for a code the panel never sent',
    file: GRID,
    find: '      : `grid status not OK (gridSta=${sta})`;',
    to: "      : 'grid not detected (gridSta=0)'; /* MUTANT */",
    why: 'The reason contradicts the shp2_grid_status sensor beside it.',
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
    find: '    curtailment: !!i.curtailment && i.curtailment.basisComplete === true,',
    to: '    curtailment: !!i.curtailment, /* MUTANT */',
    why: 'pv_curtailment_kwh_today (total_increasing) dips to 0 at boot: Home Assistant books a reset and counts the day again.',
  },
  {
    id: 'vi-b. \u2605\u2605\u2605 a weather-cold curtailment report claims a complete basis',
    file: AN,
    find: '    basisComplete: weather != null && bayes.hourly.length > 0,',
    to: '    basisComplete: true, /* MUTANT */',
    why: 'The first Open-Meteo fetch after a restart fails: every hour samples null, 0 kWh publishes, and the reset the release removed comes back by another path.',
  },
  {
    id: 'vi-c. \u2605 weather alone is taken as a basis (no posterior yet)',
    file: AN,
    find: '    basisComplete: weather != null && bayes.hourly.length > 0,',
    to: '    basisComplete: weather != null, /* MUTANT */',
    why: 'With no paired history every hour still samples null: the same model-less 0.',
  },
  {
    id: 'vi-d. \u2605\u2605 the early-return (no home Cores / no panel) report claims a complete basis',
    file: AN,
    find: '    basisComplete: false,\n  };',
    to: '    basisComplete: true, /* MUTANT */\n  };',
    why: 'The boot publish (before the first poll) returns the empty report: its 0 kWh is published as a reading.',
  },
  {
    id: 'vi-e. \u2605\u2605 the binary curtailment sensor renders a withheld null as OFF',
    file: MQTT,
    find: `value_template: '{{ "None" if value_json.pv_curtailment_active is none else ("ON" if value_json.pv_curtailment_active else "OFF") }}' },`,
    to: `value_template: '{{ "ON" if value_json.pv_curtailment_active else "OFF" }}' }, /* MUTANT */`,
    why: 'An on\u2192off edge at every restart while curtailing: automations that return loads when curtailment ends fire on a restart.',
  },
  {
    id: 'vii. \u2605\u2605 fleet flows publish before any Core is projected',
    file: READY,
    find: "    flow: membershipKnown && Object.entries(i.devices).some(([sn, d]) => d.online && d.projection?.kind === 'dpu' && isShp2Connected(d.sn ?? sn, connected)),",
    to: '    flow: devs.length > 0, /* MUTANT */',
    why: 'Fleet PV and battery net read 0 W at boot \u2014 the Energy dashboard\u2019s solar and battery rates notch to zero.',
  },
  {
    id: 'vii-b. \u2605 a bench spare alone makes the fleet flows "real"',
    file: READY,
    find: "    flow: membershipKnown && Object.entries(i.devices).some(([sn, d]) => d.online && d.projection?.kind === 'dpu' && isShp2Connected(d.sn ?? sn, connected)),",
    to: "    flow: membershipKnown && Object.entries(i.devices).some(([, d]) => d.online && d.projection?.kind === 'dpu'), /* MUTANT */",
    why: 'Every home Core wedged, a spare online: aggregateFleetFlow sums over nothing and 0 W publishes as a reading.',
  },
  {
    id: 'vii-d. \u2605 a panel listed but not projected is taken for a DPU-only install',
    file: READY,
    find: '  const membershipKnown = !!panel || shp2Panels(asSnapshots).sns.length === 0;',
    to: '  const membershipKnown = true; /* MUTANT */',
    why: 'A restart with the panel cloud-offline publishes a bench spare\u2019s figures as the home fleet.',
  },
  {
    id: 'vii-c. the live charge ceiling is withheld with the weather-gated curtailment figures',
    file: READY,
    find: "    'pv_curtailment_kwh_7d',\n",
    to: "    'pv_curtailment_kwh_7d', 'pv_curtailment_charge_ceiling_pct', /* MUTANT */\n",
    why: 'The Cores\u2019 own chgMaxSoc reads unknown for as long as Open-Meteo is down.',
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
    find: '  value.basisComplete = dpus.length > 0 && (shp2 != null || shp2Panels(devices).sns.length === 0);',
    to: '  value.basisComplete = true; /* MUTANT */',
    why: 'Boot-partial grid cost / solar value / net savings publish as real figures.',
  },
  {
    id: 'x-b. \u2605 a DPU-only install is never a complete tariff basis',
    file: AN,
    find: '  value.basisComplete = dpus.length > 0 && (shp2 != null || shp2Panels(devices).sns.length === 0);',
    to: '  value.basisComplete = dpus.length > 0 && shp2 != null; /* MUTANT */',
    why: 'With no panel at all the ac_in grid cost is real, and would read unknown forever.',
  },
  {
    id: 'xi. \u2605\u2605 the forecast never flags a model-less PV forecast',
    file: AN,
    find: '  value.pvForecastUnavailable = restoredPvSpan === 0;',
    to: '  value.pvForecastUnavailable = false; /* MUTANT */',
    why: 'The boot forecast\u2019s 0 kWh is published to Home Assistant as a forecast, at every restart.',
  },
  {
    id: 'xi-b. \u2605 the flag judges the REPORTING basis, not the published one',
    file: AN,
    find: '  value.pvForecastUnavailable = restoredPvSpan === 0;',
    to: '  value.pvForecastUnavailable = homeDpus.length === 0 || pvSpan === 0; /* MUTANT */',
    why: 'Every home Core wedged at a restart: their own recorded PV makes a real display forecast, and it reads unknown for as long as the wedge.',
  },
  {
    id: 'xi-c. \u2605\u2605\u2605 the MQTT publisher takes the fleet sums BEFORE the reports\u2019 await (the boot race)',
    file: MQTT,
    find: '    const analytics = getAnalytics();',
    to: '    const earlyFlow = aggregateFleetFlow(snap.devices); void earlyFlow; /* MUTANT */\n    const analytics = getAnalytics();',
    why: 'The first poll lands during the await: readiness passes the pre-poll 0 W sums as readings (battery net, panel load X \u2192 0 \u2192 X at every restart).',
  },
  {
    id: 'xi-d. \u2605\u2605 the REST twin takes the fleet sums before the reports\u2019 await',
    file: IDX,
    find: '  // Cached projections (internally cached ~30min — cheap to call per-request).',
    to: '  const earlyFlow = aggregateFleetFlow(snap.devices); void earlyFlow; /* MUTANT */',
    why: 'Same race on /api/ha-state.',
  },
  {
    id: 'xi-e. \u2605 an await between the sums and the readiness verdict reopens the race',
    file: MQTT,
    find: '    const { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad } = aggregateFleetFlow(snap.devices);',
    to: '    const { fleetPv, fleetIn, fleetOut, acIn, fleetBatteryNet, panelLoad } = aggregateFleetFlow(snap.devices); await Promise.resolve(); /* MUTANT */',
    why: 'Anything that yields between the two lets a poll land between the sums and the verdict.',
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
