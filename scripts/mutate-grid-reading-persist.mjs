#!/usr/bin/env node
/**
 * mutate-grid-reading-persist.mjs — committed harness for v1.180.0: the SHP2's last NOT-OK grid
 * reading survives a restart (server/src/snapshot.ts grid-reading.json), and the declared-grid
 * veto (server/src/gridState.ts) finds an unprojected panel by identity to read it.
 *
 * WHY COMMITTED: the failure is silent and in the missed-alarm direction. An outage with the
 * grid toggle ON, a panel gone cloud-dark and an add-on restart brought "grid present" back —
 * runway audible gated, off_grid OFF, SoC crossings spoken as "drawing from grid power" — for as
 * long as the panel stayed dark. Nothing errors.
 *
 *   node scripts/mutate-grid-reading-persist.mjs
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
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const GRID = resolve(SERVER, 'src/gridState.ts');
const IDX = resolve(SERVER, 'src/index.ts');

const SUBSET = ['test/gridReadingPersist.test.ts', 'test/gridMeasuredAbsentVeto.test.ts', 'test/presenceFreshReadback.test.ts', 'test/gridState.test.ts'];

const MUTANTS = [
  {
    id: 'i. \u2605\u2605\u2605 the persisted reading is not rehydrated on first sight',
    file: SNAP,
    find: '        ...(existing == null && this.persistedGridReadings.has(d.sn)',
    to: '        ...(false && existing == null && this.persistedGridReadings.has(d.sn) /* MUTANT */',
    why: 'A restart with the panel dark brings "grid present" back mid-outage: the runway audible is gated again.',
  },
  {
    id: 'ii. \u2605\u2605\u2605 the veto only looks at a PROJECTED panel',
    file: GRID,
    // v1.185.0 — the identity census now feeds every panel to the veto.
    find: "    .filter((d) => d.projection?.kind === 'shp2' || (d.productName ?? '').toLowerCase().includes('smart home panel'))",
    to: "    .filter((d) => d.projection?.kind === 'shp2') /* MUTANT */",
    why: 'The rehydrated reading sits on a panel with no projection; the veto never sees it.',
  },
  {
    id: 'iii. \u2605\u2605 a Grid OK reading does not delete the persisted entry',
    file: SNAP,
    find: '    else if (!this.persistedGridReadings.delete(sn)) return; // Grid OK and nothing persisted: no write',
    to: '    else return; /* MUTANT */',
    why: 'After the grid returns, the next restart with the panel dark resurrects "no grid": a stale alarm on a healthy grid.',
  },
  {
    id: 'iv. \u2605 a persisted Grid OK is rehydrated',
    file: SNAP,
    find: '        if (v && v.connected === false && typeof v.atMs === \'number\' && Number.isFinite(v.atMs)) {',
    to: '        if (v && typeof v.connected === \'boolean\' && typeof v.atMs === \'number\' && Number.isFinite(v.atMs)) { /* MUTANT */',
    why: 'Only a not-OK reading has any business surviving a restart; a stale "1" must never come back.',
  },
  {
    id: 'v. \u2605 the file is rewritten on every poll, not on change',
    file: SNAP,
    find: '      if (prev?.connected !== cur.lastGridReading.connected || prev?.sta !== cur.lastGridReading.sta) {',
    to: '      if (true) { /* MUTANT */',
    why: 'A write every 60 s on the Pi\u2019s storage for nothing.',
  },
  {
    id: 'vi. \u2605\u2605 persistence defaults ON outside the add-on (a shared file across test processes)',
    file: SNAP,
    find: "      ?? (process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json') : '');",
    to: "      ?? resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json'); /* MUTANT */",
    why: 'One test process\u2019s reading rehydrates into another\u2019s store: order-dependent vetoes in unrelated tests.',
  },
  {
    id: 'vii. \u2605\u2605\u2605 persistence is OFF in production too (the path defaults to disabled)',
    file: SNAP,
    find: "      ?? (process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, '..', 'grid-reading.json') : '');",
    to: "      ?? ''; /* MUTANT */",
    why: 'The add-on never saves a reading: the whole release is inert exactly where it matters, and every other test still passes.',
  },
  {
    id: 'viii. \u2605\u2605\u2605 the file is loaded on first sight only (the internet-down restart never gets there)',
    file: SNAP,
    find: '    // reaches setDeviceList (refreshAll throws at listDevices), and that is the outage case.\n    this.loadGridReadings();',
    to: '    // reaches setDeviceList (refreshAll throws at listDevices), and that is the outage case. /* MUTANT */',
    why: 'An outage that also takes the internet down, plus a restart: the saved reading is never read and "grid present" returns.',
  },
  {
    id: 'ix. \u2605\u2605\u2605 ANY successful list ends the persisted veto (an empty or partial list is a glitch, not evidence)',
    file: SNAP,
    find: '    const sn = [...this.unseenPersistedGrid].find((s) => this.persistedGridReadings.get(s)?.connected === false);',
    to: '    if (this.lastDeviceListSuccessAt > 0) return null; /* MUTANT */\n    const sn = [...this.unseenPersistedGrid].find((s) => this.persistedGridReadings.get(s)?.connected === false);',
    why: 'A first list that comes back empty or without the panel republishes "grid present" mid-outage.',
  },
  {
    id: 'ix-b. \u2605\u2605 the panel\u2019s own listing does not hand the reading over',
    file: SNAP,
    find: '    for (const sn of seenThisList) this.unseenPersistedGrid.delete(sn);',
    to: '    /* MUTANT */',
    why: 'The no-list path keeps serving a reading the panel\u2019s device now carries and may since have cleared.',
  },
  {
    id: 'ix-c. \u2605 a replaced panel\u2019s saved reading is never pruned',
    file: SNAP,
    find: '    if (listedPanels.length > 0) {',
    to: '    if (false) { /* MUTANT */',
    why: 'Months later, a restart during an internet-only outage vetoes a healthy grid on the old panel\u2019s reading.',
  },
  {
    id: 'x. \u2605\u2605\u2605 the resolver ignores the persisted reading when no panel device exists',
    file: GRID,
    find: '  const persistedAbsent = idPanels.length === 0 ? input.persistedGridAbsent ?? null : null;',
    to: '  const persistedAbsent = null; /* MUTANT */',
    why: 'The store has the reading; the veto never sees it through an internet-down restart.',
  },
  {
    id: 'xi. \u2605\u2605 the live wrapper does not pass the persisted reading',
    file: GRID,
    find: '    persistedGridAbsent: persistedGridAbsentSource?.() ?? null,',
    to: '    /* MUTANT */',
    why: 'Every production caller goes through liveGridBackstop: the input exists and is never filled.',
  },
  {
    id: 'xii. \u2605\u2605 index.ts never registers the store as the source',
    file: IDX,
    find: 'setPersistedGridAbsentSource(() => store.persistedGridAbsent());',
    to: '/* MUTANT */',
    why: 'The wiring exists, is tested, and the running add-on never connects it.',
  },
  {
    id: 'xiii. \u2605 a failed save is never retried',
    file: SNAP,
    find: '      } else if (this.gridReadingDirty) {',
    to: '      } else if (false) { /* MUTANT */',
    why: 'One transient write error leaves the file out of step with the panel until the next change.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-grid-reading-persist', mutants: MUTANTS, subset: SUBSET, root: REPO });
