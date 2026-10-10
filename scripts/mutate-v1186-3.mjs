#!/usr/bin/env node
/**
 * mutate-v1186-3.mjs — committed harness for v1.186.3: grid wording says what is MEASURED
 * ("available as backup" unless grid import flows), and two boot edges past the alert
 * monitor's hydration bound (a feed's pre-hydration answer is not its first delivery; a
 * live-snapshot orphan is not resolved from an unhydrated store), both scoped to ids derived
 * from device data (storm-* and the alarm-host alerts behave as on v1.186.2).
 *
 *   node scripts/mutate-v1186-3.mjs
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
const LP = resolve(SERVER, 'src/lightingPosture.ts');
const AL = resolve(SERVER, 'src/alerts.ts');
const RA = resolve(SERVER, 'src/runwayAlarm.ts');
const SOC = resolve(SERVER, 'src/batterySocAlarm.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AC = resolve(SERVER, 'src/analyticsClient.ts');

const SUBSET = [
  'test/gridWordingHonest.test.ts',
  'test/lightingPosture.test.ts',
  'test/bootHydrationEdges.test.ts',
  'test/bootSequencing.test.ts',
  'test/restartIntegrity.test.ts',
];

const MUTANTS = [
  // ── FIX 1 — grid wording ────────────────────────────────────────────────────────────────
  {
    id: 'i. ★★★ the posture reason says the grid supplies the house whenever it is backup',
    file: LP,
    find: '      reason: i.gridImportLive === true',
    to: '      reason: i.gridBackstopping === true /* MUTANT */',
    why: 'HA\'s Lighting Posture Reason reads "grid supplying the house" all afternoon at 0 W imported.',
  },
  {
    id: 'ii. ★★ the reserve alerts claim grid power at 0 W imported',
    file: AL,
    find: '  return grid?.importLive === true ? \'drawing from grid power\' : \'the grid is available as backup\';',
    to: '  return \'drawing from grid power\'; /* MUTANT */',
    why: 'A backup pool at the floor with solar carrying the house is reported as "drawing from grid power".',
  },
  {
    id: 'iii. ★★ the spoken floor advisory claims grid power at 0 W imported',
    file: RA,
    find: '      : `Advisory. ${poolEn(o)} reached the reserve floor. The grid is available as backup; no action needed.`;',
    to: '      : `Advisory. ${poolEn(o)} reached the reserve floor. Now drawing from grid power; no action needed.`; /* MUTANT */',
    why: 'The speakers announce "Now drawing from grid power" while no grid power flows.',
  },
  {
    id: 'iv. ★ the SoC-band advisory claims grid power at 0 W imported',
    file: SOC,
    find: '${importLive === true ? \'drawing from grid power\' : \'the grid is available as backup\'}',
    to: '${\'drawing from grid power\' /* MUTANT */}',
    why: 'The SoC ladder\'s grid-downgraded advisory says the grid is supplying the house when it is only backup.',
  },
  // ── FIX 2 — boot edges past the hydration bound ─────────────────────────────────────────
  {
    id: 'v. ★★★ a feed\'s pre-hydration answer counts as its first delivery',
    file: AM,
    find: '          if (startedHydrated) hydratedLanded = true;',
    to: '          hydratedLanded = true; /* MUTANT */',
    why: 'An empty answer from the worker\'s empty map warms the feed: the onset prune erases the pre-restart onsets and the standing alarms rise again as new.',
  },
  {
    id: 'vi. ★★★ a worker-served alarm first reappearing on a later pass is a new rise',
    file: AM,
    find: 'firstAppearance: isDeviceDerivedAlertId(a.id) ? !seenSinceBoot.has(a.id) : nonDeviceFirstDeliveryIds.has(a.id),',
    to: 'firstAppearance: isDeviceDerivedAlertId(a.id) ? !seenSinceBoot.has(a.id) && alertFeedOwning(a.id) == null /* MUTANT */ : nonDeviceFirstDeliveryIds.has(a.id),',
    why: 'After a boot into a cloud outage, a standing baseline alarm returning on a later pass counts a phantom rise.',
  },
  {
    id: 'vii. ★★ the warm-up prune bound runs from boot, not hydration',
    file: AM,
    find: '        ? hydratedAtMs != null && now - hydratedAtMs >= LEARNED_RESOLVE_GRACE_MS',
    to: '        ? now - bootMs >= LEARNED_RESOLVE_GRACE_MS /* MUTANT */',
    why: 'A cloud outage longer than 10 min at boot prunes every feed-owned onset while no feed has computed on a device.',
  },
  {
    id: 'viii. ★★ the worker is taken as hydrated before it holds the hydrated map',
    file: AM,
    find: '      return typeof c.snapshotHydrated === \'function\' ? c.snapshotHydrated() : true;',
    to: '      return true; /* MUTANT */',
    why: 'A report computed on the worker\'s empty map in the 750 ms before the hydrated map is posted warms the feed.',
  },
  {
    id: 'ix. ★★★ a live-snapshot orphan is resolved from an unhydrated store',
    file: AM,
    find: '    alertFeedOwning(id) == null && isDeviceDerivedAlertId(id) && !storeHydrated();',
    to: '    false; /* MUTANT */',
    why: 'Ten minutes into a boot-time cloud outage, "Resolved: Core 2 offline" is pushed while the add-on sees nothing.',
  },
  {
    id: 'x. ★★ the client never marks the worker\'s map hydrated',
    file: AC,
    find: '      if (hydrationFlushed) markSnapshotHydrated();',
    to: '      /* MUTANT */',
    why: 'The worker-served feeds never warm: their alerts stay provisional and their orphans held until the deadline.',
  },
  {
    id: 'xi. ★ a report in flight across hydration is cached',
    file: AC,
    find: '          if (ttl > 0 && gen === reportGen) reportCache.set(key, { value: v, expiresAt: Date.now() + ttl });',
    to: '          if (ttl > 0 /* MUTANT */) reportCache.set(key, { value: v, expiresAt: Date.now() + ttl });',
    why: 'A value computed on the empty map is served for its TTL after the worker holds the hydrated one.',
  },
  // ── FIX 3 — only DEVICE-derived ids wait for hydration ──────────────────────────────────
  {
    id: 'xii. ★★★ the NWS storm feed waits for the EcoFlow device list',
    file: AM,
    find: '  const feedStormPrep = createLastGoodFeed<Alert[]>(\'storm-prep\', log);',
    to: '  const feedStormPrep = createLastGoodFeed<Alert[]>(\'storm-prep\', log, undefined, feedHydrated); /* MUTANT */',
    why: 'In a device-list outage an ended storm\'s card stands for 6 h, and a NEW warning is logged as a re-track and never pushed.',
  },
  {
    id: 'xiii. ★★★ every live-snapshot orphan is held for hydration, device-derived or not',
    file: AM,
    find: '    alertFeedOwning(id) == null && isDeviceDerivedAlertId(id) && !storeHydrated();',
    to: '    alertFeedOwning(id) == null && !storeHydrated(); /* MUTANT */',
    why: 'A recovered alarm-host alert (under-voltage, dead voice) is never resolved during a device-list outage.',
  },
  {
    id: 'xiv. ★★ a non-device onset waits for hydration past the warm-up window',
    file: AM,
    find: '        : now - bootMs >= LEARNED_RESOLVE_GRACE_MS),',
    to: '        : hydratedAtMs != null && now - hydratedAtMs >= LEARNED_RESOLVE_GRACE_MS /* MUTANT */),',
    why: 'An alarm-host alert that recurs hours into a device-list outage is stamped with the onset of the episode before the restart.',
  },
  {
    id: 'xv. ★★★ a non-device alert first appearing on a later pass is re-tracked',
    file: AM,
    find: 'firstAppearance: isDeviceDerivedAlertId(a.id) ? !seenSinceBoot.has(a.id) : nonDeviceFirstDeliveryIds.has(a.id),',
    to: 'firstAppearance: !seenSinceBoot.has(a.id) /* MUTANT */,',
    why: 'A new "Alarm voice degraded" (or storm) during a device-list outage is marked notified and never pushed.',
  },
  {
    id: 'xvi. ★★ a storm standing across the restart is a new rise on the NWS feed\'s first delivery',
    file: AM,
    find: '      firstRun || !rStormPrep.firstDelivery ? [] : (rStormPrep.value ?? []).map((a) => a.id),',
    to: '      [] /* MUTANT */,',
    why: 'With NWS slow on the first pass, every standing storm warning re-pushes after a deploy.',
  },
  // ── FIX 4 — the SoC band's on-screen grid wording ───────────────────────────────────────
  {
    id: 'xvii. ★★ the house SoC band claims grid power at 0 W imported',
    file: AL,
    find: '? `Backup reserve at ${Math.round(soc)}%, ${heldAbove ? \'near\' : \'at or below\'} the ${band.pct}% threshold — ${gridBackupClause(grid)}, no',
    to: '? `Backup reserve at ${Math.round(soc)}%, ${heldAbove ? \'near\' : \'at or below\'} the ${band.pct}% threshold — drawing from grid power /* MUTANT */, no',
    why: 'The grid-downgraded band card says "drawing from grid power" while solar carries the house, contradicting the spoken advisory.',
  },
  {
    id: 'xviii. ★★ a second panel\'s SoC band claims grid power at 0 W imported',
    file: AL,
    find: '? `${name} backup reserve at ${Math.round(soc)}%, ${heldAbove ? \'near\' : \'at or below\'} the ${band.pct}% threshold — ${gridBackupClause(grid)}, no',
    to: '? `${name} backup reserve at ${Math.round(soc)}%, ${heldAbove ? \'near\' : \'at or below\'} the ${band.pct}% threshold — drawing from grid power /* MUTANT */, no',
    why: 'The same contradiction on a second panel\'s band card.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1186-3', mutants: MUTANTS, subset: SUBSET, root: REPO });
