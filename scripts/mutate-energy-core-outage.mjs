#!/usr/bin/env node
/**
 * mutate-energy-core-outage.mjs — v1.188.1: while a home Core is cloud-offline, its battery and
 * solar energy (and the two power sensors) come from the Smart Home Panel 2's source slot; when it
 * reports again its BMS counter jump is absorbed; nothing published ever steps down.
 *
 *   B-i     the slot meter's direction is flipped (the Cores supplying the panel read as charging)
 *   B-ii    the night gate is removed (a dark night is inferred, its outflow booked as PV)
 *   B-iii   the bridged PV never reaches fleet_pv_wh
 *   B-iv    the dark Cores' own pv_total / ac_in contributors are no longer skipped
 *   B-v     the hand-over clears the marker without re-baselining the pack
 *   B-vi    the hand-over fires on every mutating pass (online gate and register movement dropped)
 *   B-vii   the hand-over ignores whether the registers moved (an online flip spends the marker)
 *   B-viii  the read-only debug pass re-baselines too
 *   B-ix    the bridge is folded into the BMS discharge floor
 *   B-x     an untrusted panel PV field is used as measured (rollup)
 *   B-xi    an untrusted panel PV field is used for the power sensors
 *   B-xii   the panel-freshness gate is dropped (rollup)
 *   B-xiii  the panel-freshness gate is dropped (power sensors)
 *   B-xiv   battery out/in book the gross slot flows (PV that passed through a Core as battery out)
 *   B-xv    flowBridged is ready while a slot is unbridgeable (readiness)
 *   B-xvi   an unbridgeable slot does not withhold the power figures (bridgeFleetFlow)
 *   B-xvii  the hand-over marker is never persisted
 *   B-xviii the bridged battery energy is not added to the emitted totals
 *   B-xix   the slots' AC input never reaches fleet_grid_import_wh
 *   B-xx    the inferred envelope is not monotone
 *   B-xxi   an uncovered window is inferred anyway
 *   B-xxii  the inferred basis ignores the Cores' measured capacity (nameplate instead)
 *   B-xxiii the power sensors' battery sign is flipped
 *
 *   node scripts/mutate-energy-core-outage.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EB = resolve(REPO, 'server/src/energyBridge.ts');
const RC = resolve(REPO, 'server/src/recorder.ts');
const PR = resolve(REPO, 'server/src/publishReadiness.ts');
const SUBSET = [
  'test/energyBridge.test.ts',
  'test/recorderEnergyBridge.test.ts',
  'test/energyBridgePublish.test.ts',
  'test/publishReadiness.test.ts',
];

const MUTANTS = [
  {
    id: 'B-i. ★★★ the slot meter\'s direction is flipped',
    file: EB,
    find: '  const out = integrateWh(pts.map((p) => ({ ts: p.ts, value: Math.max(0, -p.value) })), sinceMs, untilMs);',
    to: '  const out = integrateWh(pts.map((p) => ({ ts: p.ts, value: Math.max(0, p.value) })), sinceMs, untilMs); /* MUTANT */',
    why: 'The 10-15 nights (Cores supplying ~3.4 kW) book no battery out; a night grid charge books it as out.',
  },
  {
    id: 'B-ii. ★★★ the night gate is removed',
    file: EB,
    find: '    const night = !sunUp(since) && !sunUp(nowMs);',
    to: '    const night = false; /* MUTANT */',
    why: 'A dark night is inferred: the slots\' outflow rises the envelope and is booked as solar, not battery out.',
  },
  {
    id: 'B-iii. ★★★ the bridged PV never reaches fleet_pv_wh',
    file: RC,
    find: "      if (br && key === 'fleet_pv_wh') addedWh += br.pvWh;",
    to: '      /* MUTANT */',
    why: 'Home Assistant\'s solar reads 0.0 kWh on a dark-Core day again (10-15, 10-16).',
  },
  {
    id: 'B-iv. ★★★ the dark Cores\' own contributors are no longer skipped',
    file: RC,
    find: '        if ((sourceSns.size === 0 || sourceSns.has(d.sn)) && !bridgedSns.has(d.sn)) {',
    to: '        if (sourceSns.size === 0 || sourceSns.has(d.sn)) { /* MUTANT */',
    why: 'A frozen projection\'s held pv_total / ac_in heartbeat rows are integrated beside the bridge (double count).',
  },
  {
    id: 'B-v. ★★★ the hand-over clears the marker without re-baselining',
    file: RC,
    find: '              savePackBaseline(d.sn, pk, rebased);\n              base = rebased;\n              energyBridge.clearMarker(cacheKey);',
    to: '              energyBridge.clearMarker(cacheKey); /* MUTANT */',
    why: 'The returning Cores\' dark-day counter jump lands in one rollup on top of the bridged energy.',
  },
  {
    id: 'B-vi. ★★★ the hand-over fires on every mutating pass',
    file: RC,
    find: '            if (opts.mutate && d.online === true && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (opts.mutate && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
    why: 'A dark Core\'s frozen projection spends its marker on every read; the real jump on return lands unabsorbed.',
  },
  {
    id: 'B-vii. ★★ the hand-over ignores whether the registers moved',
    file: RC,
    find: '            if (opts.mutate && d.online === true && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (opts.mutate && d.online === true && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
    why: 'An online flip that lands before the first fresh quota spends the marker; the quota\'s jump then lands.',
  },
  {
    id: 'B-viii. ★★ the read-only debug pass re-baselines too',
    file: RC,
    find: '            if (opts.mutate && d.online === true && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (d.online === true && moved && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
    why: '/api/debug/battery-lifetime writes baselines and clears markers — a diagnostic that changes what it reports.',
  },
  {
    id: 'B-ix. ★★★ the bridge is folded into the BMS discharge floor',
    file: RC,
    find: '    if (bms.dischargeWh > bmsDischargeFloor) bmsDischargeFloor = bms.dischargeWh;\n',
    to: '    if (bms.dischargeWh > bmsDischargeFloor) bmsDischargeFloor = bms.dischargeWh;\n    if (br) bmsDischargeFloor += br.dischargeWh; /* MUTANT */\n',
    why: 'The v1.98.0 floor-gap check reads the bridged energy as a floor for a pool that no longer exists and re-seeds it DOWN — Home Assistant books a meter reset (the phantom-kWh failure).',
  },
  {
    id: 'B-x. ★★★ an untrusted panel PV field is used as measured (rollup)',
    file: EB,
    find: '        if (isTrusted(s.panelSn, s.slot)) {',
    to: '        if (true) { /* MUTANT */',
    why: 'A field never seen above 0 W reads 0 in daylight: the day\'s solar books as nothing and the Cores\' output as battery out.',
  },
  {
    id: 'B-xi. ★★ an untrusted panel PV field is used for the power sensors',
    file: EB,
    find: "  if (trusted && s.pvW != null) return 'measured';",
    to: "  if (s.pvW != null) return 'measured'; /* MUTANT */",
    why: 'Fleet PV publishes a made-up 0 W at noon and Battery Net the slots\' whole output.',
  },
  {
    id: 'B-xii. ★★★ the panel-freshness gate is dropped (rollup)',
    file: EB,
    find: '      if (!s.panelFresh) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A frozen or replayed panel reading is integrated as battery energy.',
  },
  {
    id: 'B-xiii. ★★ the panel-freshness gate is dropped (power sensors)',
    file: EB,
    find: "  if (!s.panelFresh || s.chW == null) return 'unbridgeable';",
    to: "  if (s.chW == null) return 'unbridgeable'; /* MUTANT */",
    why: 'Battery Net publishes a frozen panel reading as a live one.',
  },
  {
    id: 'B-xiv. ★★★ battery out/in book the gross slot flows',
    file: EB,
    find: '      const split = windowSplit(ac.acOutWh, ac.acInWh, pvWh);',
    to: '      const split = { outWh: ac.acOutWh, inWh: ac.acInWh }; /* MUTANT */',
    why: 'Solar that passed through a Core to the house is booked as battery out; PV charging is not battery in.',
  },
  {
    id: 'B-xv. ★★ flowBridged is ready while a slot is unbridgeable',
    file: PR,
    find: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && fb.bridgedSlots > 0)) && fb.ready;',
    to: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && fb.bridgedSlots > 0)); /* MUTANT */',
    why: 'The two power sensors publish a partial sum as the fleet\'s.',
  },
  {
    id: 'B-xvi. ★★ an unbridgeable slot does not withhold the power figures',
    file: EB,
    find: "    if (basis === 'unbridgeable') { ready = false; continue; }",
    to: "    if (basis === 'unbridgeable') { continue; } /* MUTANT */",
    why: 'Fleet PV / Battery Net publish without a slot that cannot be read — a figure, not an unknown.',
  },
  {
    id: 'B-xvii. ★★★ the hand-over marker is never persisted',
    file: EB,
    find: '        deps.writeLifetime(bridgeDarkKey(pk), 1, nowMs);',
    to: '        /* MUTANT */',
    why: 'A restart mid-outage forgets which packs were bridged; their jump on return lands in one rollup.',
  },
  {
    id: 'B-xviii. ★★★ the bridged battery energy is not added to the emitted totals',
    file: RC,
    find: "      if (key === 'fleet_battery_discharge_wh') persistedWh += bridgeTotals.dischargeWh;",
    to: '      /* MUTANT */',
    why: 'Battery out reads 0 kWh through a Core outage again.',
  },
  {
    id: 'B-xix. ★★ the slots\' AC input never reaches fleet_grid_import_wh',
    file: RC,
    find: "      if (br && key === 'fleet_grid_import_wh') addedWh += br.gridImportWh;",
    to: '      /* MUTANT */',
    why: 'Grid to Battery Charge reads 0 through a dark-Core night charge.',
  },
  {
    id: 'B-xx. ★★ the inferred envelope is not monotone',
    file: EB,
    find: '  const env = Math.max(st.envWh, f, 0);',
    to: '  const env = Math.max(f, 0); /* MUTANT */',
    why: 'A one-percent SoC step down books negative solar.',
  },
  {
    id: 'B-xxi. ★★ an uncovered window is inferred anyway',
    file: EB,
    find: '  if (!covered || !(capWh > 0)) return { state: { anchorPct: pctEnd, cumAcNetWh: 0, envWh: 0 }, pvWh: null };',
    to: '  if (!(capWh > 0)) return { state: { anchorPct: pctEnd, cumAcNetWh: 0, envWh: 0 }, pvWh: null }; /* MUTANT */',
    why: 'A restart or panel gap lands the SoC change it spans in one window as solar.',
  },
  {
    id: 'B-xxii. ★ the inferred basis ignores the Cores\' measured capacity',
    file: EB,
    find: '    const measured = c.wh != null && c.wh > 0 ? c.wh : null;',
    to: '    const measured = null as number | null; /* MUTANT */',
    why: 'The SoC term uses nameplate, overstating stored energy by the packs\' capacity ratio (0.944).',
  },
  {
    id: 'B-xxiii. ★★★ the power sensors\' battery sign is flipped',
    file: EB,
    find: '    net += -(s.chW as number) - p;',
    to: '    net += (s.chW as number) - p; /* MUTANT */',
    why: 'Battery Net reads charging while the Cores supply the house (the Now view\'s consumption inverts).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energy-core-outage', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
