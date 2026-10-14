#!/usr/bin/env node
/**
 * mutate-v1187-22a.mjs — v1.187.22: the SoC ladders (house, every secondary panel, the grid-drop
 * re-escalation pass) are fed only once the store is hydrated, bounded by BOOT_HYDRATION_MAX_MS.
 *
 *   A-i     the boot gate is removed (the 2026-10-12 22:04:09 one-Core mean is fed)
 *   A-ii    the bound is removed (never hydrated ⇒ never fed)
 *   A-iii   the bound is ignored for the secondary panels' ladders
 *   A-iv    the grid-drop re-escalation pass runs ahead of the gate
 *   A-v     the 'hydrated' event no longer runs a tick
 *   A-vi    the bound timer no longer runs a tick
 *   A-vii   the tick no longer reads the clock (the bound opens only by the timer)
 *   A-viii  hydration no longer opens the gate (every boot waits out the bound)
 *   A-ix    the bound is exclusive (off by one)
 *   A-x     the latch is never set (an opening line on every tick)
 *   A-xi    the withheld line is logged on every withheld tick
 *   A-xii   the withheld line counts online Cores, not reporting ones
 *   A-xiii  the live roster is no longer noted on a withheld tick
 *   A-xiv   index.ts ignores BATTERY_SOC_ALARM_ENABLED
 *
 *   node scripts/mutate-v1187-22a.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SL = resolve(REPO, 'server/src/socLadders.ts');
const BA = resolve(REPO, 'server/src/batterySocAlarm.ts');
const MEM = resolve(REPO, 'server/src/shp2Membership.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/socLadderBootHydration.test.ts',
  'test/batterySocAlarm.test.ts',
  'test/multiPanel.test.ts',
];

const MUTANTS = [
  {
    id: 'A-i. ★★★ the boot gate is removed',
    file: SL,
    find: '    if (!bootGateOpen(snap.devices, shp2Soc, soc)) return;',
    to: '    /* MUTANT */',
    why: 'The first tick after a reboot feeds a one-Core mean and the house hears a false 50 % rung (2026-10-12 22:06:33).',
  },
  {
    id: 'A-ii. ★★★ the bound is removed',
    file: BA,
    find: "  if (p.elapsedMs >= p.maxMs) return 'bound';",
    to: '  /* MUTANT */',
    why: 'A cloud outage at boot holds every SoC ladder silent until a first poll settles — a real depletion is never spoken.',
  },
  {
    id: 'A-iii. ★★★ the bound is ignored for the secondary panels\' ladders',
    file: SL,
    find: '      for (const p of secondaryPanels(snap.devices)) {',
    to: '      for (const p of secondaryPanels(snap.devices)) {\n        if (!(store.firstPollSettledAt > 0)) continue; /* MUTANT */',
    why: 'With the cloud slow at boot the garage pool\'s ladder stays dark past the bound while the house ladder speaks.',
  },
  {
    id: 'A-iv. ★★★ the grid-drop re-escalation pass runs ahead of the gate',
    file: SL,
    find: '    if (!bootGateOpen(snap.devices, shp2Soc, soc)) return;',
    to: '    if (!bootGateOpen(snap.devices, shp2Soc, soc)) { reEscalateHouse(soc, socGridForTick.backstopping); return; } /* MUTANT */',
    why: 'A grid-drop re-escalation is fed the one-Core boot mean and speaks a critical rung the pool may not be in.',
  },
  {
    id: 'A-v. ★★ the \'hydrated\' event no longer runs a tick',
    file: SL,
    find: "  store.on('hydrated', onHydrated);",
    to: '  /* MUTANT */',
    why: 'A real crossing present at boot waits for the next store change (up to a poll interval) before it is spoken.',
  },
  {
    id: 'A-vi. ★★ the bound timer no longer runs a tick',
    file: SL,
    find: '      if (!gateOpen) tick(store.get());',
    to: '      /* MUTANT */',
    why: 'With the cloud slow at boot and no further change, the reading withheld before the bound is never fed.',
  },
  {
    id: 'A-vii. ★★ the tick no longer reads the clock',
    file: SL,
    find: '      elapsedMs: boundReached ? Math.max(elapsedMs, maxMs) : elapsedMs,',
    to: '      elapsedMs: boundReached ? Math.max(elapsedMs, maxMs) : 0, /* MUTANT */',
    why: 'A bound timer delayed by a blocked boot event loop keeps every change past the bound withheld.',
  },
  {
    id: 'A-viii. ★★ hydration no longer opens the gate',
    file: BA,
    find: "  if (p.firstPollSettledAt > 0) return 'hydrated';",
    to: '  /* MUTANT */',
    why: 'Every boot holds the SoC ladders the full 30 s on a hydrated store, and logs a false WARNING.',
  },
  {
    id: 'A-ix. ★ the bound is exclusive',
    file: BA,
    find: "  if (p.elapsedMs >= p.maxMs) return 'bound';",
    to: "  if (p.elapsedMs > p.maxMs) return 'bound'; /* MUTANT */",
    why: 'A zero bound (ALERT_BOOT_HYDRATION_MAX_MS=0, the documented way to disable the wait) still withholds the first tick.',
  },
  {
    id: 'A-x. ★ the latch is never set',
    file: SL,
    find: '    gateOpen = true;',
    to: '    /* MUTANT */',
    why: 'An opening line is logged on every store change for the life of the process.',
  },
  {
    id: 'A-xi. ★ the withheld line is logged on every withheld tick',
    file: SL,
    find: '      if (withheldTicks === 0) {',
    to: '      if (withheldTicks >= 0) { /* MUTANT */',
    why: 'A slow boot logs one line per quota and MQTT write until the first poll settles.',
  },
  {
    id: 'A-xii. ★ the withheld line counts online Cores, not reporting ones',
    file: MEM,
    find: '    return s != null && Number.isFinite(s);',
    to: '    return d?.online === true; /* MUTANT */',
    why: 'The line reads "3 of 3 roster Cores" for a one-Core mean, hiding the partial map from a log review.',
  },
  {
    id: 'A-xiii. ★ the live roster is no longer noted on a withheld tick',
    file: SL,
    find: '    deps.noteLiveRoster(shp2ConnectedDpuSns(snap.devices));\n    const soc = shp2Soc != null ? shp2Soc : housePoolFallbackSoc(snap.devices, deps.lastKnownRoster());\n    // v1.187.22 — nothing below (house ladder, secondary ladders, re-escalation) reads a partial boot map.\n    if (!bootGateOpen(snap.devices, shp2Soc, soc)) return;',
    to: '    const soc = shp2Soc != null ? shp2Soc : housePoolFallbackSoc(snap.devices, deps.lastKnownRoster());\n    if (!bootGateOpen(snap.devices, shp2Soc, soc)) return;\n    deps.noteLiveRoster(shp2ConnectedDpuSns(snap.devices)); /* MUTANT */',
    why: 'Through the boot window the other membership consumers keep the persisted roster after the panel has reported a live one.',
  },
  {
    id: 'A-xiv. ★★ index.ts ignores BATTERY_SOC_ALARM_ENABLED',
    file: IDX,
    find: '  enabled: socAlarmEnabled,',
    to: '  enabled: true, /* MUTANT */',
    why: 'An installation that turned the SoC ladder off hears it again.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22a', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
