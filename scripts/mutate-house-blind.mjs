#!/usr/bin/env node
/**
 * mutate-house-blind.mjs — committed harness for v1.197.1: the PINNED house panel with no
 * projection raises the house's reserve-alarm-blind.
 *
 * A house panel the cloud had not returned a body for since the restart was flagged (housePanel)
 * but unprojected: findShp2 resolved it to nothing and secondaryPanels left it out, so the dark-panel
 * alarm (darkPanelBlindSince) reached only the other panels and the house pool had no reserve-blind
 * alarm at all. Now pinnedDarkHousePanel finds it, the house block raises its own reserve-alarm-blind
 * from darkPanelBlindSince (the earlier of the carried onset and the first listing: the cold-boot
 * grace is RESERVE_BLIND_AFTER_MS from that listing), on its own pool's grid verdict, and the pending
 * rule counts it as raised (darkPanelBlindRaised). Mutants H-i..vi.
 *
 * The hand-over: at a panel's first projection, a pool still unknown keeps the onset its dark alarm
 * read (SnapshotStore.applyBackupPoolGraceHold), so the alarm is not withdrawn (a "Resolved" push)
 * and back 15 minutes later; the first listing is stamped on the store's clock, the clock those
 * onsets are kept on. Mutants K-i..v.
 *
 * Re-pointed in this release: mutate-restart-leftovers.mjs D-iii (now a pin MISSING from the
 * account, which has no reserve-blind alarm), mutate-v1187-4.mjs C-i (the carried onset dropped
 * from the hand-over's minimum).
 *
 * Not mutated: the alert's words and facts (shared with the projected house panel and pinned there:
 * reserveBlindFailover.test.ts; the hand-over test compares the two field for field); `device:
 * blindHouse.deviceName` (the same object as shp2 whenever shp2 is defined).
 *
 *   MUTATE_CONCURRENCY=2 node scripts/mutate-house-blind.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it; the unmutated tree must typecheck and pass them first.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AL = resolve(SERVER, 'src/alerts.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');

const T_HOUSE = 'test/houseReserveBlindDark.test.ts';
const T_POOL = 'test/poolUnknownCarry.test.ts';
const T_MULTI = 'test/multiPanel.test.ts';
const T_FAILOVER = 'test/reserveBlindFailover.test.ts';

const MUTANTS = [
  /* ── H: the pinned dark house panel's own alarm ── */
  {
    id: 'H-i. ★★★ the pinned dark house panel raises nothing (v1.197.0)',
    file: AL, tests: [T_HOUSE, T_POOL],
    find: '  const darkHouse = shp2 ? undefined : pinnedDarkHousePanel(devices);',
    to: '  const darkHouse = (false as boolean) ? pinnedDarkHousePanel(devices) : undefined; /* MUTANT */',
    why: 'The house pool is dark after a restart and the only alert is the grid-offgrid info: nothing says the reserve alarm cannot see it.',
  },
  {
    id: 'H-ii. ★★★ blind since its lastUpdated (0: never updated)',
    file: AL, tests: [T_HOUSE],
    find: '      blindSinceMs = darkPanelBlindSince(darkHouse.sn, connectivity);',
    to: '      blindSinceMs = darkHouse.lastUpdated ?? null; /* MUTANT */',
    why: 'A cold boot with the house panel not projected yet raises an off-grid critical "unreadable for 20,000 d" at the first evaluation: no boot grace.',
  },
  {
    id: 'H-iii. ★★ blind since its first listing only: the carried onset ignored',
    file: AL, tests: [T_HOUSE, T_POOL],
    find: '      blindSinceMs = darkPanelBlindSince(darkHouse.sn, connectivity);',
    to: '      blindSinceMs = connectivity?.panelFirstListedBySn?.get(darkHouse.sn) ?? null; /* MUTANT */',
    why: 'An off-grid critical standing at a restart is absent 15 min, then a warning until boot + 60, while the pending rule (carried onset) says it is raised.',
  },
  {
    id: 'H-iv. ★★ the plant grid verdict, not the house pool\'s own',
    file: AL, tests: [T_HOUSE],
    find: '    const grid = darkHouse && poolGrid ? poolGrid(darkHouse.sn) : housePoolGrid;',
    to: '    const grid = housePoolGrid; /* MUTANT */',
    why: 'On a two-panel plant the garage panel\'s grid import holds the dark house pool\'s alarm at a warning: it never escalates off-grid.',
  },
  {
    id: 'H-v. ★★ a pin MISSING from the account counts as the dark house panel',
    file: AL, tests: [T_HOUSE],
    find: "    if (d.housePanel === true) return d.projection?.kind === 'shp2' ? undefined : d;",
    to: "    if (d.housePanel === true || d.housePanelMissing != null) return d.projection?.kind === 'shp2' ? undefined : d; /* MUTANT */",
    why: 'A panel off the account (shp2-multi-panel critical) raises a second alarm for the same cause, and the pending rule lets it go.',
  },
  {
    id: 'H-vi. ★★★ the pending rule leaves the pinned dark house panel out (v1.197.0)',
    file: AL, tests: [T_HOUSE, T_POOL],
    find: '  for (const panel of darkHouse ? [...secondaryPanels(devices), darkHouse] : secondaryPanels(devices)) {',
    to: '  for (const panel of secondaryPanels(devices)) { /* MUTANT */',
    why: 'The alarm stands but the alert set stays unsettled for as long as the house panel is dark: the alert and the rule drift apart.',
  },
  {
    id: 'H-vii. ★ the monitor keys the first listings by PROJECTED panel',
    file: AM, tests: [T_HOUSE],
    find: '      panelFirstListedBySn: new Map(shp2Panels(snap.devices).sns.map((sn) => [sn, store.firstListedAt(sn)] as const)),',
    to: '      panelFirstListedBySn: new Map(allShp2s(snap.devices).map((p) => [p.sn, store.firstListedAt(p.sn)] as const)), /* MUTANT */',
    why: 'In production the dark house panel has no listing: on a cold boot (nothing carried) its alarm never stands.',
  },

  /* ── K: the hand-over at the first projection ── */
  {
    id: 'K-i. ★★★ the clock restarts at the first projection',
    file: SN, tests: [T_HOUSE],
    find: '        const listed = firstProjection ? this.firstListedAtBySn.get(sn) : undefined;',
    to: '        const listed = firstProjection && (false as boolean) ? this.firstListedAtBySn.get(sn) : undefined; /* MUTANT */',
    why: 'A house panel dark 70 min reports a pool still unknown: its critical is withdrawn (a "Resolved" push), back as a warning 15 min later.',
  },
  {
    id: 'K-ii. ★★ every projection takes the first listing',
    file: SN, tests: [T_HOUSE, T_POOL],
    find: '        const listed = firstProjection ? this.firstListedAtBySn.get(sn) : undefined;',
    to: '        const listed = firstProjection || (true as boolean) ? this.firstListedAtBySn.get(sn) : undefined; /* MUTANT */',
    why: 'A pool that goes unknown hours after the boot is blind since the boot: an off-grid critical at once.',
  },
  {
    id: 'K-iii. ★★ no projection counts as the first',
    file: SN, tests: [T_HOUSE],
    find: '    const firstProjection = !this.backupPoolHoldBySn.has(sn);',
    to: '    const firstProjection = this.backupPoolHoldBySn.has(sn); /* MUTANT */',
    why: 'As K-i at the hand-over, and as K-ii on every later projection.',
  },
  {
    id: 'K-iv. ★★ the onset may be later than now',
    file: SN, tests: [T_HOUSE, T_POOL, T_FAILOVER],
    find: '        this.backupPoolUnknownSinceBySn.set(sn, Math.min(carried ?? Infinity, listed ?? Infinity, nowMs));',
    to: '        this.backupPoolUnknownSinceBySn.set(sn, Math.min(carried ?? Infinity, listed ?? Infinity)); /* MUTANT */',
    why: 'A pool that goes unknown later in the process has an onset of Infinity: its reserve-blind alarm never stands.',
  },
  {
    id: 'K-v. ★ the first listing on the wall clock, the onsets on the store\'s',
    file: SN, tests: [T_POOL, T_MULTI],
    find: '    const listedAtMs = this.now();',
    to: '    const listedAtMs = now; /* MUTANT */',
    why: 'Under an injected clock (every pool-unknown test) a first projection reads blind since the wall-clock listing, months off.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-house-blind', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
