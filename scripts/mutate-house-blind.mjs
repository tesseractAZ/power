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
 * Review of v1.197.1 (houseReserveBlindCarry.test.ts, houseReserveBlindMonitor.test.ts):
 *  - P: the onset of a panel dark since a COLD boot is saved (SnapshotStore.darkListedOnsets): a
 *    second restart while it stays dark carried nothing, so the critical was absent 15 min (the boot
 *    orphan sweep pushed "Resolved"), then a warning until 60 min after the new listing. Its first
 *    projection rewrites the file. Mutants P-i..vii.
 *  - Q: a one-panel plant keeps its pin while its panel is off the device lists (resolveHousePanel's
 *    `mapped`): dark, it became a secondary panel and its alarm moved between `reserve-alarm-blind`
 *    and `reserve-alarm-blind-<serial>`, a "Resolved" push and a new critical at each move. Q-i..iv.
 *  - S: the house alarm names its panel (sourceSn), so the evidence gate holds a vanish while that
 *    panel has no fresh data (a dark pinned panel leaving the account on a two-panel plant). S-i.
 *  - R: the monitor awaits the HA refresh before building its connectivity context: a first quota
 *    landing during that await dropped the standing alarm for one pass. R-i.
 *
 * Re-pointed in this release: mutate-restart-leftovers.mjs D-iii (now a pin MISSING from the
 * account, which has no reserve-blind alarm), mutate-v1187-4.mjs C-i (the carried onset dropped
 * from the hand-over's minimum); after the review, mutate-v1187-4.mjs C-xxiii and
 * mutate-multi-panel.mjs (the resolveHousePanel call, now with the device map).
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
const SM = resolve(SERVER, 'src/shp2Membership.ts');

const T_HOUSE = 'test/houseReserveBlindDark.test.ts';
const T_POOL = 'test/poolUnknownCarry.test.ts';
const T_MULTI = 'test/multiPanel.test.ts';
const T_FAILOVER = 'test/reserveBlindFailover.test.ts';
const T_CARRY = 'test/houseReserveBlindCarry.test.ts';
const T_MON = 'test/houseReserveBlindMonitor.test.ts';

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

  /* ── P: the onset of a panel dark since a cold boot is saved ── */
  {
    id: 'P-i. ★★★ a panel listed and never projected is not saved (v1.197.1 before the review)',
    file: SN, tests: [T_CARRY, T_MON],
    find: '    for (const [sn, listedMs] of this.darkListedOnsets()) {',
    to: '    for (const [sn, listedMs] of new Map<string, number>()) { /* MUTANT */',
    why: 'A house panel dark since a cold boot, critical, restarts dark: absent 15 min (the boot sweep pushes "Resolved"), then a warning until 60 min after the new listing.',
  },
  {
    id: 'P-ii. ★★ the poll loop\'s refresh does not count them',
    file: SN, tests: [T_CARRY, T_MON],
    find: '      || this.darkListedOnsets().size > 0)) this.writePoolUnknown();',
    to: '      || (false as boolean))) this.writePoolUnknown(); /* MUTANT */',
    why: 'As P-i whenever no pool is read unknown in the process: nothing triggers the save.',
  },
  {
    id: 'P-iii. ★★★ the first projection leaves the saved onset on file',
    file: SN, tests: [T_CARRY],
    find: '    if (firstProjection && this.poolUnknownDarkOnFile.delete(sn)) changed = true;',
    to: '    if (firstProjection && (false as boolean) && this.poolUnknownDarkOnFile.delete(sn)) changed = true; /* MUTANT */',
    why: 'A panel slow to report at boot reads its pool, restarts dark within the hour: "blind since" the old listing, critical early.',
  },
  {
    id: 'P-iv. ★★ saved from a process whose file is untrusted',
    file: SN, tests: [T_POOL],
    find: '    if (this.poolUnknownUntrusted) return out;',
    to: '    if ((false as boolean) && this.poolUnknownUntrusted) return out; /* MUTANT */',
    why: 'A read-only /data remounted while the process runs: the untrusted process writes onsets the next one carries.',
  },
  {
    id: 'P-v. ★★ saved as blind since now',
    file: SN, tests: [T_CARRY],
    find: '      out[sn] = { sinceMs: listedMs, lastSeenMs: Math.max(listedMs, nowMs) };',
    to: '      out[sn] = { sinceMs: nowMs, lastSeenMs: Math.max(listedMs, nowMs) }; /* MUTANT */',
    why: 'The next process carries a few seconds of blindness: absent 15 min, a warning until 60 min, as before.',
  },
  {
    id: 'P-vi. ★ a carried entry overwritten by this process\'s later listing',
    file: SN, tests: [T_CARRY],
    find: '      if (out[sn] != null) continue;',
    to: '      if ((false as boolean) && out[sn] != null) continue; /* MUTANT */',
    why: 'A third restart while dark carries the second process\'s listing: the onset moves later at every restart.',
  },
  {
    id: 'P-vii. ★ a projected panel saved too',
    file: SN, tests: [T_CARRY],
    find: "      if (this.snap.devices[sn]?.projection?.kind === 'shp2') continue;",
    to: "      if ((false as boolean) && this.snap.devices[sn]?.projection?.kind === 'shp2') continue; /* MUTANT */",
    why: 'A panel whose pool reads is on file as unknown since its listing: a restart within the hour raises a false critical.',
  },

  /* ── Q: a one-panel plant keeps its pin while its panel is off the device lists ── */
  {
    id: 'Q-i. ★★★ an empty census flags no panel (v1.197.1 before the review)',
    file: SM, tests: [T_CARRY],
    find: "    return { sn: pinnedSn != null && mapped.length === 1 && mapped[0] === pinnedSn ? pinnedSn : null, pin: pinnedSn, state: 'none' };",
    to: "    return { sn: mapped.length < 0 ? pinnedSn : null, pin: pinnedSn, state: 'none' }; /* MUTANT */",
    why: 'A one-panel plant\'s dark panel off three lists becomes a secondary panel: reserve-alarm-blind-<serial> replaces the house alarm, a "Resolved" and a new critical.',
  },
  {
    id: 'Q-ii. ★★ the pin keeps the role beside another mapped panel',
    file: SM, tests: [T_CARRY],
    find: "    return { sn: pinnedSn != null && mapped.length === 1 && mapped[0] === pinnedSn ? pinnedSn : null, pin: pinnedSn, state: 'none' };",
    to: "    return { sn: pinnedSn != null && mapped.includes(pinnedSn) ? pinnedSn : null, pin: pinnedSn, state: 'none' }; /* MUTANT */",
    why: 'Two panels both off the lists: one is flagged, and the two-panels-none-pinned write block and critical are lifted.',
  },
  {
    id: 'Q-iii. ★★ the store does not pass the device map',
    file: SN, tests: [T_CARRY],
    find: '    const r = resolveHousePanel(census, this.housePanelPin, this.pinCandidateLists >= FIRST_PIN_LISTS, shp2Panels(this.snap.devices).sns);',
    to: '    const r = resolveHousePanel(census, this.housePanelPin, this.pinCandidateLists >= FIRST_PIN_LISTS); /* MUTANT */',
    why: 'As Q-i, through the store.',
  },
  {
    id: 'Q-iv. ★ the store passes the pin as the device map',
    file: SN, tests: [T_CARRY],
    find: '    const r = resolveHousePanel(census, this.housePanelPin, this.pinCandidateLists >= FIRST_PIN_LISTS, shp2Panels(this.snap.devices).sns);',
    to: "    const r = resolveHousePanel(census, this.housePanelPin, this.pinCandidateLists >= FIRST_PIN_LISTS, [this.housePanelPin ?? '']); /* MUTANT */",
    why: 'As Q-ii, through the store.',
  },

  /* ── S: the house alarm names its panel ── */
  {
    id: 'S-i. ★★ the house alarm names no serial (v1.197.1 before the review)',
    file: AL, tests: [T_CARRY, T_MON],
    find: '        sourceSn: blindHouse.sn,',
    to: '        /* MUTANT: no sourceSn */',
    why: 'A dark pinned panel leaving the account on a two-panel plant pushes "Resolved: Reserve alarm blind" while the pool is still unread.',
  },

  /* ── R: the context and computeAlerts read one state of the store ── */
  {
    id: 'R-i. ★★★ an await between the connectivity context and computeAlerts (v1.197.1 before the review)',
    file: AM, tests: [T_MON],
    find: '    const grid = liveGridBackstop(snap.devices);\n',
    to: '    if (gridPresenceEntityId()) await haStateCache.refreshIfStale(); /* MUTANT */\n    const grid = liveGridBackstop(snap.devices);\n',
    why: 'A first quota landing during the HA refresh drops the standing alarm for one pass: "Resolved", then the alarm again.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-house-blind', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
