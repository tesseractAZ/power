#!/usr/bin/env node
/**
 * mutate-energy-core-outage.mjs — v1.188.1: while a home Core is cloud-offline, its battery and
 * solar energy (and the two power sensors) come from the Smart Home Panel 2's source slot, from
 * the instant it went offline (a blip inside the dwell is not bridged); day and night are judged
 * at the configured site; the panel's PV field is used only once checked against the inferred
 * lower bound; a slot on a cloud-offline panel is left out of the power sensors; register
 * movement while the Core has not reported since its return is absorbed, and when it has, its BMS
 * counter jump is absorbed; nothing published ever steps down.
 *
 *   B-i     the slot meter's direction is flipped (the Cores supplying the panel read as charging)
 *   B-ii    the night gate is removed (a dark night is inferred, its outflow booked as PV)
 *   B-iii   the bridged PV never reaches fleet_pv_wh
 *   B-iv    the dark Cores' own pv_total / ac_in contributors are no longer skipped
 *   B-v     the hand-over / absorption does not re-baseline the pack
 *   B-vi    the hand-over fires on any online flag (not only once the Core reported since its return)
 *   B-vii   the hand-over ignores whether the registers moved (a content change spends the marker)
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
 *   B-xxiv  a read drops an offline Core's own energy up to its flip (PV steps DOWN at a daylight flip)
 *   B-xxv   a read ignores the hand-off cut (shows energy past the flip the next rollup will not keep)
 *   B-xxvi  the dwell is removed (a 6 s blip activates the bridge, writes markers, double-counts)
 *   B-xxvii the bridge's window ignores the hand-off instant (re-books what the BMS / pv_total counted)
 *   B-xxviii a rollup inside the dwell cuts the Core too (its energy over the blip is lost)
 *   B-xxix  a slot's inferred state outlives its dark span (a later span lands the SoC rise as solar)
 *   B-xxx   the panel PV field is trusted on its first daylight reading (no corroboration)
 *   B-xxxi  a trusted panel PV field is never revoked
 *   B-xxxii the field verdict needs no evidence
 *   B-xxxiii the field verdict allows no SoC step
 *   B-xxxiv the field trust is not reloaded at a restart
 *   B-xxxv  the 15-min window clamp is removed (the first window after a restart spans the downtime)
 *   B-xxxvi a handed-over marker's row is never deleted (re-absorbed after every restart)
 *   B-xxxvii the hand-over line's BMS discharge figure is zeroed
 *   B-xxxviii the hand-over line's BMS charge figure is zeroed
 *   B-xxxix the hand-over clears the per-Core figures (the "no longer bridged" line reads 0.00)
 *   B-xl    the per-Core figures are never cleared
 *   B-xli   the PV / Grid to Battery Charge dip backstop is removed
 *   B-xlii  register movement of a marked pack is not absorbed while its Core is listed offline
 *   B-xliii the energy absorbed before the hand-over is left out of the hand-over line
 *   B-xliv  the absorbed rows outlive the hand-over
 *   B-xlv   the absorption is not recorded at all
 *   B-xlvi  reportsSinceReturn ignores the online flip (data from before it counts as the return)
 *   B-xlvii reportsSinceReturn takes a Core online since first sight as reported (a replayed first body)
 *   B-xlviii reportsSinceReturn ignores the online flag (MQTT data while dark spends the marker)
 *   B-xlix  the sun test ignores the site it is given (Phoenix's clock everywhere)
 *   B-l     the bridge's site ignores the configured location
 *   B-li    the configured site is not validated (NaN / out of range)
 *   B-lii   a slot on a cloud-offline panel withholds the whole plant's power figures again
 *   B-liii  a slot on an online but stale panel is left out instead of withholding
 *   B-liv   the rollup's day/night test ignores the configured site
 *   B-lv    the power sensors' day/night test ignores the configured site
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
  'test/recorderEnergyBridgeTransitions.test.ts',
  'test/energyBridgePublish.test.ts',
  'test/publishReadiness.test.ts',
  'test/lifetimeDipClamp.test.ts',
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
    find: '      if (!sunUp(start, site) && !sunUp(nowMs, site)) {',
    to: '      if (false) { /* MUTANT */',
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
    id: 'B-iv. ★★★ the dark Cores\' own contributors are no longer cut at the hand-off',
    file: RC,
    find: '          const untilMs = ownEnergyUntil(offline.get(d.sn), phase);',
    to: '          const untilMs = undefined as number | null | undefined; /* MUTANT */',
    why: 'A frozen projection\'s held pv_total / ac_in heartbeat rows are integrated beside the bridge (double count).',
  },
  {
    id: 'B-v. ★★★ the hand-over / absorption does not re-baseline the pack',
    file: RC,
    find: '              savePackBaseline(d.sn, pk, rebased);\n              base = rebased;\n              bmsSuspectStreak.delete(cacheKey);',
    to: '              /* MUTANT */\n              bmsSuspectStreak.delete(cacheKey);',
    why: 'The returning Cores\' dark-day counter jump lands in one rollup on top of the bridged energy.',
  },
  {
    id: 'B-vi. ★★★ the hand-over fires on any online flag',
    file: RC,
    find: '              if (reportsSinceReturn(d)) {',
    to: '              if (d.online === true) { /* MUTANT */',
    why: 'The review defect: a reconnect burst of queued MQTT data from early in the dark span, just before the online flip, spends the marker; the fresh data\'s jump then lands on top of the bridged energy.',
  },
  {
    id: 'B-vii. ★★ the hand-over ignores whether the registers moved',
    file: RC,
    find: '            if (opts.mutate && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (opts.mutate && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
    why: 'A content change without pack data after the online flip spends the marker; the real jump then lands.',
  },
  {
    id: 'B-viii. ★★ the read-only debug pass re-baselines too',
    file: RC,
    find: '            if (opts.mutate && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (moved && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
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
    find: '        if (fieldWh != null && isTrusted(s.panelSn, s.slot)) {',
    to: '        if (fieldWh != null) { /* MUTANT */',
    why: 'A field never checked reads 0 in daylight: the day\'s solar books as nothing and the Cores\' output as battery out.',
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
  {
    id: 'B-xxiv. ★★★ a read drops an offline Core\'s own energy up to its flip',
    file: RC,
    find: '          const until = c.untilMs === undefined ? now : c.untilMs === null ? watermark : Math.min(now, c.untilMs);',
    to: '          const until = c.untilMs === undefined ? now : watermark; /* MUTANT */',
    why: 'The v1.188.1 review defect: a Core going dark between rollups in daylight takes its pending PV / ac_in with it — PV Production steps DOWN (here held flat by the backstop, and no longer rising with the Cores that report).',
  },
  {
    id: 'B-xxv. ★★ a read ignores the hand-off cut',
    file: RC,
    find: "    const contributors = buildContributors(snap, 'read', now);",
    to: "    const contributors = buildContributors(snap, 'rollup', now); /* MUTANT */",
    why: 'Inside the dwell a read shows the offline Core\'s held / extrapolated PV past its flip, which the rollup that hands it to the bridge does not keep.',
  },
  {
    id: 'B-xxvi. ★★★ the dwell is removed',
    file: EB,
    find: '  return { offlineSinceMs, bridged: offlineSinceMs == null || nowMs - offlineSinceMs >= BRIDGE_DWELL_MS };',
    to: '  return { offlineSinceMs, bridged: true }; /* MUTANT */',
    why: 'A 6 s /status blip at a rollup activates the bridge: markers, three log lines, and the window\'s battery energy booked beside the BMS.',
  },
  {
    id: 'B-xxvii. ★★★ the bridge\'s window ignores the hand-off instant',
    file: EB,
    find: '      const start = Math.max(since, s.darkSinceMs ?? since);',
    to: '      const start = since; /* MUTANT */',
    why: 'An outage that starts mid-window books the part before the flip twice: the BMS / pv_total counted it, and the bridge books it again.',
  },
  {
    id: 'B-xxviii. ★★ a rollup inside the dwell cuts the Core too',
    file: EB,
    find: "  if (phase === 'rollup' && !o.bridged) return undefined;",
    to: '  /* MUTANT */',
    why: 'A blip shorter than the dwell that straddles a rollup loses the Core\'s own PV from its flip to that rollup; the bridge never counts it.',
  },
  {
    id: 'B-xxix. ★★★ a slot\'s inferred state outlives its dark span',
    file: EB,
    find: '    for (const k of [...infer.keys()]) if (!live.has(k)) infer.delete(k);',
    to: '    /* MUTANT */',
    why: 'A second dark span hours later reuses the old anchor: the whole charge gained since lands in one window as solar (+10 kWh per Core).',
  },
  {
    id: 'B-xxx. ★★★ the panel PV field is trusted on its first daylight reading',
    file: EB,
    find: '    const v = pvFieldVerdict(c.fieldWh, c.inferredWh, c.stepWh);',
    to: "    const v = c.fieldWh > 0 ? 'consistent' as const : pvFieldVerdict(c.fieldWh, c.inferredWh, c.stepWh); /* MUTANT */",
    why: 'The review defect: a field reading only part of the solar is trusted for good; pass-through PV books as battery out.',
  },
  {
    id: 'B-xxxi. ★★★ a trusted panel PV field is never revoked',
    file: EB,
    find: '    if (trusted.delete(tk)) {\n      deps.deleteLifetime(tk);',
    to: '    if (trusted.has(tk)) return; /* MUTANT */\n    if (trusted.delete(tk)) {\n      deps.deleteLifetime(tk);',
    why: 'A field that stops reading the pass-through PV keeps the measured basis: solar under-counted for the rest of the outage.',
  },
  {
    id: 'B-xxxii. ★★ the field verdict needs no evidence',
    file: EB,
    find: "  if (!(stepWh > 0) || inferredWh < BRIDGE_PV_EVIDENCE_STEPS * stepWh) return 'pending';",
    to: "  if (!(stepWh > 0)) return 'pending'; /* MUTANT */",
    why: 'The first daylight window decides: within the bound\'s one-step error any field passes.',
  },
  {
    id: 'B-xxxiii. ★★ the field verdict allows no SoC step',
    file: EB,
    find: "  return fieldWh >= inferredWh - stepWh ? 'consistent' : 'below';",
    to: "  return fieldWh >= inferredWh ? 'consistent' : 'below'; /* MUTANT */",
    why: 'The integer percent makes the bound good to one step; a true field one step short of it is rejected.',
  },
  {
    id: 'B-xxxiv. ★★ the field trust is not reloaded at a restart',
    file: EB,
    find: '  const trusted = new Set<string>(keys.filter((k) => k.startsWith(PVSEEN_PREFIX)));',
    to: '  const trusted = new Set<string>(); /* MUTANT */',
    why: 'After every restart Fleet PV and Battery Net read unknown in daylight until the check passes again.',
  },
  {
    id: 'B-xxxv. ★★ the 15-min window clamp is removed',
    file: EB,
    find: '    since = Math.max(since, nowMs - BRIDGE_MAX_WINDOW_MS);',
    to: '    /* MUTANT */',
    why: 'The first window after a restart spans the downtime: one judged on daylight at its start books nothing for the night it covers.',
  },
  {
    id: 'B-xxxvi. ★★★ a handed-over marker\'s row is never deleted',
    file: EB,
    find: '      if (!markers.delete(k)) return { chgWh: 0, dsgWh: 0 };\n      deps.deleteLifetime(bridgeDarkKey(k));',
    to: '      if (!markers.delete(k)) return { chgWh: 0, dsgWh: 0 }; /* MUTANT */',
    why: 'Every restart reloads the marker: the pack\'s next register movement is absorbed again, forever.',
  },
  {
    id: 'B-xxxvii. ★★ the hand-over line\'s BMS discharge figure is zeroed',
    file: RC,
    find: '                h.dsgWh += before.dsgWh + dsgWh;',
    to: '                h.dsgWh += 0; /* MUTANT */',
    why: 'The statistics repair reads its preferred battery-out target from this line: it would book 0 kWh.',
  },
  {
    id: 'B-xxxviii. ★★ the hand-over line\'s BMS charge figure is zeroed',
    file: RC,
    find: '                h.chgWh += before.chgWh + chgWh;',
    to: '                h.chgWh += 0; /* MUTANT */',
    why: 'The same for battery in.',
  },
  {
    id: 'B-xxxix. ★★ the hand-over clears the per-Core figures',
    file: RC,
    find: "        `the panel bridge counted ${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out (AC basis, already published)`,\n      );\n",
    to: "        `the panel bridge counted ${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out (AC basis, already published)`,\n      );\n      if (energyBridge.markersOf(sn).length === 0) energyBridge.clearCore(sn); /* MUTANT */\n",
    why: 'The review defect: the "no longer bridged" line that follows reads 0.00 kWh in / 0.00 kWh out.',
  },
  {
    id: 'B-xl. ★ the per-Core figures are never cleared',
    file: EB,
    find: '      if (m && !bridging.has(m[1]) && markersOf(m[1]).length === 0) clearCore(m[1]);',
    to: '      /* MUTANT */',
    why: 'A later outage of the same Core starts its hand-over figures from the old ones.',
  },
  {
    id: 'B-xli. ★★ the PV / Grid to Battery Charge dip backstop is removed',
    file: RC,
    find: '        LIFETIME_HOLD_KEYS.has(key) ? LIFETIME_HOLD_DIP_WH : undefined,',
    to: '        undefined, /* MUTANT */',
    why: 'A Core whose slot leaves the panel mid-window steps PV Production down by its pending share (above the 50 Wh micro-dip clamp).',
  },
  {
    id: 'B-xlii. ★★★ register movement of a marked pack is not absorbed while its Core is listed offline',
    file: RC,
    find: '            if (opts.mutate && moved && pk.accuChgMah != null && pk.accuDsgMah != null) {',
    to: '            if (opts.mutate && d.online === true && moved && pk.accuChgMah != null && pk.accuDsgMah != null) { /* MUTANT */',
    why: 'The review defect: MQTT data that still arrives while the cloud lists the Cores offline leaves the held value behind the projection; a content change after the flip then hands over on that stale register, and the dark-span jump lands on top of the bridged energy (double).',
  },
  {
    id: 'B-xliii. ★★ the energy absorbed before the hand-over is left out of the hand-over line',
    file: RC,
    find: '                h.dsgWh += before.dsgWh + dsgWh;',
    to: '                h.dsgWh += dsgWh; /* MUTANT */',
    why: 'The line under-states what the BMS counted while dark by the part MQTT delivered before the return.',
  },
  {
    id: 'B-xliv. ★★ the absorbed rows outlive the hand-over',
    file: EB,
    find: "      deps.deleteLifetime(bridgeAbsorbedKey(k, 'chg'));\n      deps.deleteLifetime(bridgeAbsorbedKey(k, 'dsg'));",
    to: '      /* MUTANT */',
    why: 'A later outage of the same pack starts its hand-over figure from the old absorbed energy.',
  },
  {
    id: 'B-xlv. ★★ the absorption is not recorded',
    file: EB,
    find: '    absorb: (k, chgWh, dsgWh) => {\n      if (!markers.has(k)) return;',
    to: '    absorb: (k, chgWh, dsgWh) => {\n      if (!markers.has(k) || k.length > 0) return; /* MUTANT */',
    why: 'The debug block and the hand-over line lose what was absorbed while the Core was listed offline.',
  },
  {
    id: 'B-xlvi. ★★★ reportsSinceReturn ignores the online flip',
    file: EB,
    find: '  return o == null || c >= o;',
    to: '  return o == null || c >= 0; /* MUTANT */',
    why: 'Data from before the flip (a reconnect burst of queued MQTT data) counts as the return: the marker is spent on an early register.',
  },
  {
    id: 'B-xlvii. ★★ reportsSinceReturn takes a Core online since first sight as reported without a content change',
    file: EB,
    find: '  if (c == null) return false;',
    to: '  if (c == null) return finite(d.onlineChangedAtMs) == null; /* MUTANT */',
    why: 'After a restart the first body (it may be a replay) spends the marker; the rest of the dark span lands when the Core streams.',
  },
  {
    id: 'B-xlviii. ★★★ reportsSinceReturn ignores the online flag',
    file: EB,
    find: '  if (d.online !== true) return false;',
    to: '  /* MUTANT */',
    why: 'MQTT data while the Core is listed offline spends the marker mid-outage; the return\'s jump then lands.',
  },
  {
    id: 'B-xlix. ★★★ the sun test ignores the site it is given',
    file: EB,
    find: '  return solarPosition(new Date(ms), site.lat, site.lon).elevation > 0;',
    to: '  return solarPosition(new Date(ms), PHOENIX_SITE.lat, PHOENIX_SITE.lon).elevation > 0; /* MUTANT */',
    why: 'The review defect: outside Phoenix a local morning takes the night basis (solar booked as battery out) and a local night the inferred one (both power sensors unknown all night).',
  },
  {
    id: 'B-l. ★★★ the bridge\'s site ignores the configured location',
    file: RC,
    find: '    site: () => bridgeSite(config),',
    to: '    site: () => bridgeSite({ forecastLat: 33.4484, forecastLon: -112.074 }), /* MUTANT */',
    why: 'FORECAST_LAT / FORECAST_LON are set to the install, but the bridge keeps judging day and night on Phoenix\'s clock.',
  },
  {
    id: 'B-li. ★ the configured site is not validated',
    file: EB,
    find: '  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };',
    to: '  if (lat === lat || lon === lon) return { lat, lon }; /* MUTANT */',
    why: 'An option read as NaN makes every window night (elevation NaN): solar books as battery out.',
  },
  {
    id: 'B-lii. ★★★ a slot on a cloud-offline panel withholds the whole plant\'s power figures again',
    file: EB,
    find: '    if (!s.panelOnline) {',
    to: '    if (false) { /* MUTANT */',
    why: 'The review defect: on a two-panel plant a garage panel that drops off the cloud with its Core blanks the house\'s Fleet PV and Battery Net for the whole outage.',
  },
  {
    id: 'B-liii. ★★ a slot on an online but stale panel is left out instead of withholding',
    file: EB,
    find: '    if (!s.panelOnline) {',
    to: '    if (!s.panelFresh) { /* MUTANT */',
    why: 'A panel listed online whose reading is momentarily stale publishes a partial sum as the fleet\'s.',
  },
  {
    id: 'B-liv. ★★ the rollup\'s day/night test ignores the configured site',
    file: EB,
    find: '    const site = deps.site();',
    to: '    const site = PHOENIX_SITE; /* MUTANT */',
    why: 'Outside Phoenix a local morning\'s dark-Core windows take the night basis: the solar they pass to the house books as battery out.',
  },
  {
    id: 'B-lv. ★★ the power sensors\' day/night test ignores the configured site',
    file: EB,
    find: '    flow: (online, devices, nowMs) => bridgeFleetFlow(online, devices, nowMs, isTrusted, deps.site()),',
    to: '    flow: (online, devices, nowMs) => bridgeFleetFlow(online, devices, nowMs, isTrusted, PHOENIX_SITE), /* MUTANT */',
    why: 'Outside Phoenix Fleet PV and Battery Net read unknown through the local night of a Core outage (Phoenix daylight, no trusted field).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energy-core-outage', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
