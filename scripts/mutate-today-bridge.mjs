#!/usr/bin/env node
/**
 * mutate-today-bridge.mjs — committed harness for v1.190.2: the dashboard's Today card (and the Solar
 * tab's Today tile) while home Cores are dark.
 *
 * WHY COMMITTED: on 2026-10-19 every home Core had been cloud-offline for five days and the house ran
 * on the batteries, and the card read Solar produced 0 Wh, AC output 0 Wh, Batteries (net) 0 Wh
 * "charged", "25% measured", while Home Assistant's Energy counters — which the energy bridge feeds
 * from the panel's slot meters — read 41.3 kWh of solar and 34.5 / 9.4 kWh battery in / out. The card
 * integrated the Cores' own sample series, which the recorder rightly stops writing while a Core is
 * dark. It now adds the energy the bridge booked (the bridge_ledger rows) for each bridged window and
 * leaves the Core's own samples out of those windows. Each regression below puts a confident,
 * plausible figure on the dashboard (a zero, a double count across a hand-over, a "100% measured", an
 * inferred lower bound shown as a reading); none fails a build.
 *
 *   node scripts/mutate-today-bridge.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; each mutant runs in its own copy of the tree
 *   (scripts/lib/mutateParallel.mjs), so the working tree is never written. Each mutant must
 *   typecheck (tsconfig.test.json).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AGG = resolve(SERVER, 'src/aggregator.ts');
const BRIDGE = resolve(SERVER, 'src/energyBridge.ts');
const REC = resolve(SERVER, 'src/recorder.ts');
const READ = resolve(SERVER, 'src/readRecorder.ts');
const REPORTS = resolve(SERVER, 'src/reports.ts');
const INDEX = resolve(SERVER, 'src/index.ts');
const TEXT = resolve(REPO, 'web/src/cards/todayText.ts');
const CARD = resolve(REPO, 'web/src/cards/TodaySummary.tsx');
const SOLAR = resolve(REPO, 'web/src/pages/SolarPanel.tsx');

const SUBSET = ['test/todayBridge.test.ts', 'test/aggregator.test.ts', 'test/dashboardAuditFour.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ computeTotals ignores the bridge (the 2026-10-19 card: 0 Wh solar, 0 Wh AC output, 25 % measured)',
    file: AGG,
    find: '  const bridged = opts.bridged === true ? bridgedView(recorder.bridgeLedger(sinceMs, untilMs), sinceMs, untilMs) : null;',
    to: '  const bridged = false ? bridgedView(recorder.bridgeLedger(sinceMs, untilMs), sinceMs, untilMs) : null; /* MUTANT */',
    why: 'Every dark day reads zero solar and zero battery flow while Home Assistant books tens of kWh.',
  },
  {
    id: 'ii. ★★★ the Core\'s own samples are not cut inside the bridged windows (a double count)',
    file: AGG,
    find: '      const own = integrateWhOutside(pts, sinceMs, untilMs, cut);',
    to: '      const own = integrateWhOutside(pts, sinceMs, untilMs, []); /* MUTANT */',
    why: 'Readings recorded while the bridge still meters the slot (MQTT data while the cloud lists the Core offline) are counted beside the bridged energy.',
  },
  {
    id: 'iii. ★★ the bridge\'s open window is not extended to the read',
    file: AGG,
    find: '    if (ledger.watermarkMs > 0 && end === ledger.watermarkMs && untilMs > end) list.push([Math.max(end, sinceMs), untilMs]);',
    to: '    /* MUTANT */',
    why: 'Between rollups the card shows own samples the next rollup takes back: the figure steps down.',
  },
  {
    id: 'iv. ★★ a window still open at the read\'s end is counted before it is booked',
    file: AGG,
    find: "    if (r.untilMs > untilMs) continue; // booked after the window's end",
    to: '    /* MUTANT */',
    why: 'A past window\'s figure counts energy the lifetime counters booked after it ended (the day\'s change disagrees with Home Assistant\'s).',
  },
  {
    id: 'v. ★★★ the bridged energy is not added to the fleet figures',
    file: AGG,
    find: '    fleet.pvWh += b.pvWh;\n    fleet.acOutWh += b.acOutWh;',
    to: '    /* MUTANT */',
    why: 'Solar produced and AC output read 0 on a dark day while the bridged block itself is present.',
  },
  {
    id: 'vi. ★★★ the battery net takes the wrong sign of the bridged split',
    file: AGG,
    find: '    fleet.batteryNetWh += b.dischargeWh - b.chargeWh;',
    to: '    fleet.batteryNetWh += b.chargeWh - b.dischargeWh; /* MUTANT */',
    why: 'A charging day reads "discharged".',
  },
  {
    id: 'vii. ★★★ "% measured" ignores the slot meters\' coverage',
    file: AGG,
    find: '      cut ? Math.min(1, ((ownCoverageMs[metric] ?? 0) + (bridged?.coveredMs.get(d.sn) ?? 0)) / r.totalMs) : r.coverageMs / r.totalMs;',
    to: '      cut ? Math.min(1, (ownCoverageMs[metric] ?? 0) / r.totalMs) : r.coverageMs / r.totalMs; /* MUTANT */',
    why: 'A fully panel-metered day reads "25% measured" beside figures that are all measured.',
  },
  {
    id: 'viii. ★★ the slot coverage is not prorated to the overlap',
    file: AGG,
    find: '    coveredMs.set(r.sn, (coveredMs.get(r.sn) ?? 0) + Math.max(0, r.coveredMs) * ((e - s) / (r.untilMs - r.sinceMs)));',
    to: '    coveredMs.set(r.sn, (coveredMs.get(r.sn) ?? 0) + Math.max(0, r.coveredMs)); /* MUTANT */',
    why: 'A window straddling the day\'s start counts its whole coverage: "% measured" over-reads.',
  },
  {
    id: 'ix. ★★ a connected home Core with no projection is skipped again',
    file: AGG,
    find: '    const unprojectedHome = opts.bridged === true && !p && connected.has(d.sn);',
    to: '    const unprojectedHome = false && opts.bridged === true && !p && connected.has(d.sn); /* MUTANT */',
    why: 'A Core dark since a restart counts as unmeasured beside its bridged figures.',
  },
  {
    id: 'x. ★★★ the recorder writes no ledger rows',
    file: REC,
    find: '        recordBridgeLedger(bridgeLedgerRows(br));',
    to: '        recordBridgeLedger([]); /* MUTANT */',
    why: 'The card has nothing to add: back to 0 Wh on a dark day.',
  },
  {
    id: 'xi. ★★ a held rollup writes rows',
    file: BRIDGE,
    find: '  if (r.held === true) return [];\n  const out: BridgeLedgerRow[] = [];',
    to: '  const out: BridgeLedgerRow[] = []; /* MUTANT */',
    why: 'A window the bridge did not book (the next one integrates across the gap) cuts and is counted twice.',
  },
  {
    id: 'xii. ★★ a window the Core\'s own meters counted is recorded as bridged',
    file: BRIDGE,
    find: '    if (w.own === true || !(w.sinceMs < r.untilMs)) continue;',
    to: '    if (!(w.sinceMs < r.untilMs)) continue; /* MUTANT */',
    why: 'The Core\'s own PV and AC output in that window are cut out of the card while the counters keep them.',
  },
  {
    id: 'xiii. ★★ an unbooked window carries the AC the bridge computed but did not book',
    file: BRIDGE,
    find: '      acOutWh: booked ? w.acOutWh : 0,',
    to: '      acOutWh: w.acOutWh, /* MUTANT */',
    why: 'AC output counts a window whose solar could not be inferred and that the counters never booked.',
  },
  {
    id: 'xiv. ★★ the worker\'s read-only recorder returns no rows',
    file: READ,
    find: '      return { rows, watermarkMs: wm?.last_integrated_ts ?? 0 };',
    to: '      return { rows: rows.slice(0, 0), watermarkMs: wm?.last_integrated_ts ?? 0 }; /* MUTANT */',
    why: 'The endpoint runs in the analytics worker: the card would read zeros though the main recorder has the rows.',
  },
  {
    id: 'xv. ★★ the report registry drops the option',
    file: REPORTS,
    find: "a.untilMs ?? Date.now(), { bridged: a.bridged === true }),",
    to: 'a.untilMs ?? Date.now(), {}), /* MUTANT */',
    why: 'The endpoint asks for the bridged totals and gets the Cores\' own meters.',
  },
  {
    id: 'xvi. ★★★ /api/summary/today does not ask for the bridged totals',
    file: INDEX,
    find: "  const totals = await analytics.report('totals', { sinceMs: since, untilMs: until, bridged: true });",
    to: "  const totals = await analytics.report('totals', { sinceMs: since, untilMs: until }); /* MUTANT */",
    why: 'The 2026-10-19 card.',
  },
  {
    id: 'xvii. ★★ an inferred lower bound is labelled a reading',
    file: TEXT,
    find: "    if (b.pvInferredWh > 0 && w.measured === 0) solar = 'via panel · lower bound';",
    to: "    if (b.pvInferredWh > 0 && w.measured === 0) solar = 'via panel'; /* MUTANT */",
    why: 'Solar inferred from the slot net and the stored-energy rise (short of the Cores\' own draw) reads as measured.',
  },
  {
    id: 'xviii. ★★ a night-only bridged span marks Solar "via panel"',
    file: TEXT,
    find: '  const daylight = w.measured + w.inferred > 0;',
    to: '  const daylight = w.night + w.measured + w.inferred > 0; /* MUTANT */',
    why: 'The Cores\' own solar after a night outage is said to come from the panel.',
  },
  {
    id: 'xix. ★★ the card does not mark Solar',
    file: CARD,
    find: '<Tile label="Solar produced" value={fmtWh(data?.fleet.pvWh)} accent="text-warn" sub={notes.solar ?? undefined} />',
    to: '<Tile label="Solar produced" value={fmtWh(data?.fleet.pvWh)} accent="text-warn" /* MUTANT */ />',
    why: 'A panel-metered figure is presented as the Cores\' own.',
  },
  {
    id: 'xx. ★★ the Solar tab\'s Today tile does not mark its figure',
    file: SOLAR,
    find: '  const solarNote = todayNotes(summary?.fleet.bridged).solar;',
    to: '  const solarNote = null as string | null; void todayNotes; /* MUTANT */',
    why: 'The tab shows the bridged solar as measured by the Cores.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs); the
// subset decides (fullSuite: false) and each mutant must typecheck.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-today-bridge', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
