#!/usr/bin/env node
/**
 * mutate-multi-panel.mjs — committed harness for v1.185.0: two smart panels, supported. The house
 * panel is pinned (and cannot be displaced by a lower serial), night charge writes only to it, the
 * grid resolver reads every panel and fails loud, and every other panel carries its own reserve,
 * SoC and runway alarms.
 *
 *   node scripts/mutate-multi-panel.mjs
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
const MEMB = resolve(SERVER, 'src/shp2Membership.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const GRID = resolve(SERVER, 'src/gridState.ts');
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const RUNWAY = resolve(SERVER, 'src/panelRunway.ts');
const WORDS = resolve(SERVER, 'src/runwayAlarm.ts');

const SUBSET = ['test/multiPanel.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the pin is ignored: the lowest serial wins again',
    file: MEMB,
    find: '  if (flagged) return flagged.projection?.kind === \'shp2\' ? flagged as DeviceSnapshot & { projection: Shp2Projection } : undefined;',
    to: '  /* MUTANT */',
    why: 'A garage panel with a lower serial becomes the target of the SoC ladder, the HA backup sensors and the night-charge reserve and force-charge writes.',
  },
  {
    id: 'ii. ★★★ an unhydrated house panel falls through to the other panel',
    file: MEMB,
    find: '  if (flagged) return flagged.projection?.kind === \'shp2\' ? flagged as DeviceSnapshot & { projection: Shp2Projection } : undefined;',
    to: '  if (flagged && flagged.projection?.kind === \'shp2\') return flagged as DeviceSnapshot & { projection: Shp2Projection }; /* MUTANT */',
    why: 'For the minutes after a restart before the house panel’s first quota, a supervised write lands on the garage panel.',
  },
  {
    id: 'iii. ★★★ a pinned panel is not honoured when a second one is on the account',
    file: MEMB,
    find: '  if (pinnedSn != null && census.includes(pinnedSn)) return { sn: pinnedSn, pin: pinnedSn, ambiguous: false };',
    to: '  /* MUTANT */',
    why: 'The day panel #2 is energised the plant turns ambiguous and every supervised write stops.',
  },
  {
    id: 'iv. ★★ a single panel is never pinned',
    file: MEMB,
    find: '  if (census.length === 1) return { sn: census[0], pin: census[0], ambiguous: false };',
    to: '  /* MUTANT */',
    why: 'Nothing is flagged: the pin that is supposed to predate panel #2 never exists.',
  },
  {
    id: 'v. ★★★ the store never stamps the flag',
    file: SNAP,
    find: '      if (d.sn === r.sn) d.housePanel = true;',
    to: '      /* MUTANT */',
    why: 'The pin is persisted but nothing reads it: findShp2 falls back to the lowest serial.',
  },
  {
    id: 'vi. ★★★ presence ignores a fresh panel reporting no grid',
    file: GRID,
    find: '    if (c === false) return false;',
    to: '    /* MUTANT */',
    why: 'The garage panel islands while the house panel still reads Grid OK: presence asserts the grid through an outage on half the plant.',
  },
  {
    id: 'vii. ★★ the veto reads only the house panel',
    file: GRID,
    find: '  const vetoers = idPanels.filter((p) => panelVetoes(p));',
    to: '  const vetoers = idPanels.filter((p) => panelVetoes(p) && p.housePanel === true); /* MUTANT */',
    why: 'A declared grid stays trusted while the garage panel reports no grid.',
  },
  {
    id: 'viii. ★ grid power is not summed across panels',
    file: GRID,
    find: '    if (w != null && Number.isFinite(w) && w > 0) total += w;',
    to: '    if (w != null && Number.isFinite(w) && w > 0) total = w; /* MUTANT */',
    why: 'The plant’s grid draw reads one panel’s main.',
  },
  {
    id: 'ix. ★★★ a second panel raises no pool alarms of its own',
    file: ALERTS,
    find: '  for (const panel of secondaryShp2s(devices)) secondaryPanelAlerts(out, panel, devices, connectivity, grid, now);',
    to: '  /* MUTANT */',
    why: 'The garage pool reaches its floor off-grid in silence.',
  },
  {
    id: 'x. ★★ a second panel’s alert ids collide with the house panel’s',
    file: ALERTS,
    find: '  const sfx = `-${panel.sn}`;',
    to: '  const sfx = \'\'; /* MUTANT */',
    why: 'Two pools share one id: one alert stands in for the other and its resolve can clear a pool that is still at the floor.',
  },
  {
    id: 'xi. ★★ the ambiguity alert stands on a pinned plant',
    file: ALERTS,
    find: '  if (panels.sns.length > 1 && !list.some((d) => d.housePanel === true)) {',
    to: '  if (panels.sns.length > 1) { /* MUTANT */',
    why: 'A supported two-panel plant carries a permanent critical.',
  },
  {
    id: 'xii. ★★ a secondary band hands off to the house panel’s pair',
    file: MON,
    find: '  const sfx = m ? m[1] : \'\';',
    to: '  const sfx = \'\'; /* MUTANT */',
    why: 'The garage band clears as "moved to the reserve pair" while that pair describes the house pool: a false all-clear at the floor.',
  },
  {
    id: 'xiii. ★★ muting stays armed while a panel’s roster is missing',
    file: MON,
    find: '    return !(d.projection.sources ?? []).some((x) => x.isConnected && !!x.sn);',
    to: '    return false; /* MUTANT */',
    why: 'A reply without the garage panel’s sources demotes its Cores to off-panel hardware after three ticks.',
  },
  {
    id: 'xiv. ★★ the house blind fallback averages both pools',
    file: MEMB,
    find: '  if (house && secondaryShp2s(devices).length > 0) return panelMeanSoc(devices, house);',
    to: '  /* MUTANT */',
    why: 'A full garage bank holds the house ladder above its critical rungs while the house pool empties.',
  },
  {
    id: 'xv. ★ the plant load is one panel’s circuits',
    file: MEMB,
    find: '  for (const p of allShp2s(devices)) for (const c of p.projection.circuits ?? []) panelLoad += c.watts ?? 0;',
    to: '  for (const p of allShp2s(devices).slice(0, 1)) for (const c of p.projection.circuits ?? []) panelLoad += c.watts ?? 0; /* MUTANT */',
    why: 'A whole-plant supply is paired with half a house.',
  },
  {
    id: 'xvi. ★★★ a partial Core roster is read as a smaller drain',
    file: RUNWAY,
    find: '  return { netW: connected > 0 && reporting === connected ? net : null, reporting, connected };',
    to: '  return { netW: reporting > 0 ? net : null, reporting, connected }; /* MUTANT */',
    why: 'A Core that stops reporting while draining lengthens the runway instead of withholding it.',
  },
  {
    id: 'xvii. ★★ a coverage gap is averaged across',
    file: RUNWAY,
    find: '  if (netW == null) return [];',
    to: '  if (netW == null) return samples; /* MUTANT */',
    why: 'The mean spans a window in which some Cores were not seen.',
  },
  {
    id: 'xviii. ★★★ a frozen panel counts down',
    file: RUNWAY,
    find: '  if (!shp2ReadbackFresh(panel, nowMs)) return { ...base, unavailable: \'panel reading not fresh\' };',
    to: '  /* MUTANT */',
    why: 'A dark panel’s frozen pool is projected against a live drain.',
  },
  {
    id: 'xix. ★ no horizon on the drain runway',
    file: RUNWAY,
    find: '  const within = (h: number): number | null => (h <= PANEL_RUNWAY_HORIZON_H ? h : null);',
    to: '  const within = (h: number): number | null => h; /* MUTANT */',
    why: 'A slow evening drain announces a hundred-hour "low" every hour.',
  },
  {
    id: 'xx. ★ the drain runway claims the forecast',
    file: WORDS,
    find: 'const drain = (o?: RunwayWording): boolean => o?.basis === \'drain\';',
    to: 'const drain = (o?: RunwayWording): boolean => false; /* MUTANT */',
    why: 'The garage alarm says "before solar recovers" about a figure that never looked at solar.',
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
console.log(`mutate-multi-panel: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
