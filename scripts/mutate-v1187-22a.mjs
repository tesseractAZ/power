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
 *   A-xv    the production bound defaults to zero (the gate is off in production)
 *   A-xvi   the production bound defaults to ~24.8 days (an unbounded hold)
 *   A-xvii  index.ts passes a zero bound
 *   A-xviii index.ts silences the ladders' announce
 *   A-xix   index.ts replaces the Alert Settings toggles
 *   A-xx    index.ts no longer refreshes the grid entity before a tick
 *   A-xxi   every crossed band of a same-tick crossing announces (the collapse is lost)
 *   A-xxii  only the announced band is recorded for re-escalation (the v0.75.0 fail-silent bug)
 *   A-xxiii the house ladder ignores its pool's grid verdict
 *   A-xxiv  the house ladder ignores the Alert Settings toggles
 *   A-xxv   the on-grid advisory wording is never used
 *   A-xxvi  the advisory drops the measured import
 *   A-xxvii a secondary panel's ladder reads the house pool's grid
 *   A-xxviii a secondary panel's grid drop is never seen by its re-escalation pass
 *   A-xxix  a secondary panel records only its announced band
 *   A-xxx   the house grid-drop re-escalation ignores the Alert Settings toggles
 *   A-xxxi  the bound timer's tick re-reads the wall clock (a timer 1 ms early withholds)
 *   A-xxxii the house crossing's Spanish pass repeats the English words
 *   A-xxxiii the house crossing's Spanish pass is dropped
 *   A-xxxiv the house on-grid advisory's Spanish pass is the emergency wording
 *   A-xxxv  the house Spanish advisory drops the measured import
 *   A-xxxvi a secondary panel's Spanish crossing drops its pool's name
 *   A-xxxvii a secondary panel's Spanish advisory is spoken in English
 *   A-xxxviii the house grid-drop re-escalation's Spanish pass repeats the English words
 *   A-xxxix a secondary panel's re-escalation drops its pool's name from the Spanish pass
 *   A-xl    the reserve-alarm-blind push resolves its fallback SoC without the ladder's roster
 *   A-xli   the published roster's getter returns nothing (the push falls back to the stale literal)
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
const ALERTS = resolve(REPO, 'server/src/alerts.ts');
const SUBSET = [
  'test/socLadderBootHydration.test.ts',
  'test/socLadders.test.ts',
  'test/batterySocAlarm.test.ts',
  'test/multiPanel.test.ts',
  'test/reserveBlindRoster.test.ts',
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
  {
    id: 'A-xv. ★★★ the production bound defaults to zero',
    file: SL,
    find: '  const maxMs = deps.bootHydrationMaxMs ?? BOOT_HYDRATION_MAX_MS;',
    to: '  const maxMs = deps.bootHydrationMaxMs ?? 0; /* MUTANT */',
    why: 'index.ts passes no bound, so the gate is off in production and the 2026-10-12 22:04:09 one-Core mean is spoken again.',
  },
  {
    id: 'A-xvi. ★★★ the production bound defaults to ~24.8 days',
    file: SL,
    find: '  const maxMs = deps.bootHydrationMaxMs ?? BOOT_HYDRATION_MAX_MS;',
    to: '  const maxMs = deps.bootHydrationMaxMs ?? 2_147_483_647; /* MUTANT */',
    why: 'On a boot with the cloud down every SoC ladder stays silent until a first poll settles — a real depletion is never spoken.',
  },
  {
    id: 'A-xvii. ★★★ index.ts passes a zero bound',
    file: IDX,
    find: '  lastKnownRoster: () => lastKnownRoster,\n  log: (m) => app.log.info(m),',
    to: '  lastKnownRoster: () => lastKnownRoster,\n  bootHydrationMaxMs: 0, /* MUTANT */\n  log: (m) => app.log.info(m),',
    why: 'The production ladders never wait for a hydrated store: the false boot rung is back with every test of the gate green.',
  },
  {
    id: 'A-xviii. ★★★ index.ts silences the ladders\' announce',
    file: IDX,
    find: '  announce: (priority, message, messageEs) => broadcast.announce(priority, message, messageEs),',
    to: '  announce: async () => ({ ok: true }), /* MUTANT */',
    why: 'Every house and secondary-panel SoC rung is silent in production while the on-screen alert still shows it.',
  },
  {
    id: 'A-xix. ★★ index.ts replaces the Alert Settings toggles',
    file: IDX,
    find: '  isPriorityEnabled,\n  // Keep the grid-presence entity fresh (TTL-gated) so the tick\'s grid verdicts are live.',
    to: '  isPriorityEnabled: () => true, /* MUTANT */\n  // Keep the grid-presence entity fresh (TTL-gated) so the tick\'s grid verdicts are live.',
    why: 'A priority muted in Alert Settings is still spoken by the SoC ladders.',
  },
  {
    id: 'A-xx. ★★ index.ts no longer refreshes the grid entity before a tick',
    file: IDX,
    find: '    if (gridPresenceEntityId() || hostPowerEntityId()) await haStateCache.refreshIfStale();\n  },\n  poolGrid: livePoolGridBackstop,',
    to: '    /* MUTANT */\n  },\n  poolGrid: livePoolGridBackstop,',
    why: 'The grid verdicts read a stale cache: a grid drop is not seen and a downgraded emergency rung is not re-escalated.',
  },
  {
    id: 'A-xxi. ★★★ every crossed band of a same-tick crossing announces',
    file: SL,
    find: '      if (!isPrimary) return;',
    to: '      /* MUTANT */',
    why: 'A reconnect at a low SoC ladders 10, 8 and 4 % to the speakers in one tick instead of one alarm.',
  },
  {
    id: 'A-xxii. ★★★ only the announced band is recorded for re-escalation',
    file: SL,
    find: '      if (onGrid) socDowngraded.set(t.pct, t.priority);',
    to: '      if (onGrid && isPrimary) socDowngraded.set(t.pct, t.priority); /* MUTANT */',
    why: 'The v0.75.0 fail-silent bug: after a partial recovery a grid drop re-escalates nothing while the pool sits under 10 %.',
  },
  {
    id: 'A-xxiii. ★★★ the house ladder ignores its pool\'s grid verdict',
    file: SL,
    find: '      socGridForTick = deps.poolGrid(snap.devices, houseSnOf(snap.devices));',
    to: '      socGridForTick = { backstopping: false }; /* MUTANT */',
    why: 'Every on-grid emergency rung is spoken as critical, and no grid drop is ever re-escalated.',
  },
  {
    id: 'A-xxiv. ★★ the house ladder ignores the Alert Settings toggles',
    file: SL,
    find: '      if (!isPriorityEnabled(priority)) return;          // honour the Alert Settings annunciation toggles',
    to: '      /* MUTANT */',
    why: 'A priority muted in Alert Settings is still spoken by the house ladder.',
  },
  {
    id: 'A-xxv. ★ the on-grid advisory wording is never used',
    file: SL,
    find: '        ? socAlarmAdvisory(t.pct, undefined, socGridForTick.importLive) // v1.186.3 — wording by measured import',
    to: '        ? socAlarmMessage(t) /* MUTANT */',
    why: 'An on-grid low pool is spoken in the emergency words ("Restore charge immediately.") that the grid made a non-event.',
  },
  {
    id: 'A-xxvi. ★ the advisory drops the measured import',
    file: SL,
    find: '        ? socAlarmAdvisory(t.pct, undefined, socGridForTick.importLive) // v1.186.3 — wording by measured import',
    to: '        ? socAlarmAdvisory(t.pct, undefined, undefined) /* MUTANT */',
    why: 'The advisory says the grid is available as backup while the house is drawing from it.',
  },
  {
    id: 'A-xxvii. ★★★ a secondary panel\'s ladder reads the house pool\'s grid',
    file: SL,
    find: '        panelSocLadder(p.sn).update(own ?? panelMeanSoc(snap.devices, p), p.deviceName, deps.poolGrid(snap.devices, p.sn));',
    to: '        panelSocLadder(p.sn).update(own ?? panelMeanSoc(snap.devices, p), p.deviceName, deps.poolGrid(snap.devices, houseSnOf(snap.devices))); /* MUTANT */',
    why: 'An off-grid garage pool crossing 10 % is spoken as an advisory because the house has grid.',
  },
  {
    id: 'A-xxviii. ★★★ a secondary panel\'s grid drop is never seen by its re-escalation pass',
    file: SL,
    find: '        for (const { pct, priority } of reEscalateGridDrop(downgraded, soc, poolGrid.backstopping, isPriorityEnabled)) {',
    to: '        for (const { pct, priority } of reEscalateGridDrop(downgraded, soc, true, isPriorityEnabled)) { /* MUTANT */',
    why: 'The garage grid drops with its pool under 10 %: the downgraded emergency rung is never spoken.',
  },
  {
    id: 'A-xxix. ★★ a secondary panel records only its announced band',
    file: SL,
    find: '        if (onGrid) downgraded.set(t.pct, t.priority);',
    to: '        if (onGrid && isPrimary) downgraded.set(t.pct, t.priority); /* MUTANT */',
    why: 'The v0.75.0 fail-silent bug on the garage pool: after a partial recovery its grid drop re-escalates nothing.',
  },
  {
    id: 'A-xxx. ★ the house grid-drop re-escalation ignores the Alert Settings toggles',
    file: SL,
    find: '    for (const { pct, priority } of reEscalateGridDrop(socDowngraded, soc, backstopping, isPriorityEnabled)) {',
    to: '    for (const { pct, priority } of reEscalateGridDrop(socDowngraded, soc, backstopping, () => true)) { /* MUTANT */',
    why: 'A critical rung muted in Alert Settings is spoken anyway when the grid drops.',
  },
  {
    id: 'A-xxxi. ★★ the bound timer\'s tick re-reads the wall clock',
    file: SL,
    find: '      elapsedMs: boundReached ? Math.max(elapsedMs, maxMs) : elapsedMs,',
    to: '      elapsedMs, /* MUTANT */',
    why: 'The bound timer fires with Date.now() a millisecond short of the bound (or after a backward clock step): its tick withholds, and with the cloud down and no further change the ladders stay silent past the bound.',
  },
  {
    id: 'A-xxxii. ★★ the house crossing\'s Spanish pass repeats the English words',
    file: SL,
    find: '      const messageEs = onGrid ? socAlarmAdvisoryEs(t.pct, undefined, socGridForTick.importLive) : socAlarmMessageEs(t);',
    to: '      const messageEs = message; /* MUTANT */',
    why: 'The bilingual second pass of a house SoC rung speaks the English words twice — no rung is heard in Spanish.',
  },
  {
    id: 'A-xxxiii. ★★ the house crossing\'s Spanish pass is dropped',
    file: SL,
    find: '      void announce(priority, message, messageEs).then(',
    to: '      void announce(priority, message, null).then( /* MUTANT */',
    why: 'A bilingual installation hears every house SoC rung in English only.',
  },
  {
    id: 'A-xxxiv. ★ the house on-grid advisory\'s Spanish pass is the emergency wording',
    file: SL,
    find: 'socAlarmAdvisoryEs(t.pct, undefined, socGridForTick.importLive)',
    to: 'socAlarmMessageEs(t) /* MUTANT */',
    why: 'An on-grid low pool is a calm advisory in English and "Restablezca la carga de inmediato" in Spanish.',
  },
  {
    id: 'A-xxxv. ★ the house Spanish advisory drops the measured import',
    file: SL,
    find: 'socAlarmAdvisoryEs(t.pct, undefined, socGridForTick.importLive)',
    to: 'socAlarmAdvisoryEs(t.pct, undefined, undefined) /* MUTANT */',
    why: 'The Spanish advisory says the grid is only available as backup while the house is drawing from it.',
  },
  {
    id: 'A-xxxvi. ★★ a secondary panel\'s Spanish crossing drops its pool\'s name',
    file: SL,
    find: ': socAlarmMessageEs(t, name),',
    to: ': socAlarmMessageEs(t), /* MUTANT */',
    why: 'A garage rung is named in English and spoken as the house pool in Spanish.',
  },
  {
    id: 'A-xxxvii. ★★ a secondary panel\'s Spanish advisory is spoken in English',
    file: SL,
    find: 'onGrid ? socAlarmAdvisoryEs(t.pct, name, poolGrid.importLive)',
    to: 'onGrid ? socAlarmAdvisory(t.pct, name, poolGrid.importLive) /* MUTANT */',
    why: 'The Spanish second pass of an on-grid garage advisory repeats the English words.',
  },
  {
    id: 'A-xxxviii. ★★ the house grid-drop re-escalation\'s Spanish pass repeats the English words',
    file: SL,
    find: 'socAlarmMessage({ pct, priority }), socAlarmMessageEs({ pct, priority })).then(',
    to: 'socAlarmMessage({ pct, priority }), socAlarmMessage({ pct, priority })).then( /* MUTANT */',
    why: 'A re-escalated critical house rung is never heard in Spanish.',
  },
  {
    id: 'A-xxxix. ★★ a secondary panel\'s re-escalation drops its pool\'s name from the Spanish pass',
    file: SL,
    find: 'socAlarmMessageEs({ pct, priority }, name), \'grid-drop re-escalation\'',
    to: 'socAlarmMessageEs({ pct, priority }), \'grid-drop re-escalation\' /* MUTANT */',
    why: 'A re-escalated garage rung is spoken as the house pool in Spanish.',
  },
  {
    id: 'A-xl. ★★★ the reserve-alarm-blind push resolves its fallback SoC without the ladder\'s roster',
    file: ALERTS,
    find: '      const fallbackSoc = housePoolFallbackSoc(devices, lastKnownHomeRoster());',
    to: '      const fallbackSoc = housePoolFallbackSoc(devices); /* MUTANT */',
    why: 'Sources without isConnected: the off-grid critical push says "mean 52%" (bench Core 3 in, wired Core 5 out) while the ladder runs on 30 %.',
  },
  {
    id: 'A-xli. ★★ the published roster\'s getter returns nothing',
    file: MEM,
    find: 'export function lastKnownHomeRoster(): ReadonlySet<string> | null { return rosterOf(); }',
    to: 'export function lastKnownHomeRoster(): ReadonlySet<string> | null { return null; } /* MUTANT */',
    why: 'The alert passes no roster again and names the stale literal\'s mean, not the one the ladder runs on.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-22a', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
