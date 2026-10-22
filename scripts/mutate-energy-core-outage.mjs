#!/usr/bin/env node
/**
 * mutate-energy-core-outage.mjs — v1.188.1: while a home Core is cloud-offline, its battery and
 * solar energy (and the two power sensors) come from the Smart Home Panel 2's source slot, from
 * the instant it went offline (a blip inside the dwell is not bridged); day and night are judged
 * at the configured site; the panel's PV field is used only once checked against the inferred
 * lower bound; a slot on a cloud-offline panel is left out of the power sensors; register
 * movement while the Core has not reported since its return is absorbed, and when it has, its BMS
 * counter jump is absorbed; the hand-off instant is persisted, so a restart (a crash included)
 * hands a dark Core over where the previous process did; nothing published steps down.
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
 *   B-xi    a panel PV field the check has found short today is used for the power sensors
 *   B-xii   the rollup judges a window on the panel's reading at the instant again (round 2: the rows that exist are booked)
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
 *   B-xxxiii the field verdict's tolerance is one SoC step (2026-10-18: three honest fields revoked)
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
 *   B-lvi   a restart ignores the persisted hand-off instant (a Core first seen offline is cut at the watermark)
 *   B-lvii  the hand-off instant is never persisted
 *   B-lviii the hand-off instant outlives the Core's return
 *   B-lix   a dark Core with no projection is left out of the contributors (its pending PV drops at a crash restart)
 *   B-lx    a dark Core with no projection is not cut (its last reading is held past the flip)
 *   B-lxi   the bridge's window ignores the persisted instant (a crash restart re-books what the BMS counted)
 *   B-lxii  the recorder's cut ignores the persisted instant (PV Production steps down at a crash restart)
 *   B-lxiii a Core listed online is never dark (the cloud's flag decides again: a frozen meter is booked by nobody)
 *   B-lxiv  a bridged Core hands back on its own reading alone (MQTT back while listed offline: booked by nobody)
 *   B-lxv   a marked Core's dark instant is re-derived from the store's clocks (it moves with each MQTT delta)
 *   B-lxvi  an offline Core's dark instant ignores its later content change (dark from the flip, not its last reading)
 *   B-lxvii an offline Core's report from before the flip counts as its own reading
 *   B-lxviii an online Core with no instant is bridged at once (a restart's first body hands a live Core over)
 *   B-lxix  the first sight of an online Core with no reading is never recorded (a frozen Core after a restart is never bridged)
 *   B-lxx   the hand-off instant is deleted at an online flip, not once the Core reports
 *   B-lxxi  the power sensors sum a frozen projection listed online as live
 *   B-lxxii the power sensors leave out a Core the cloud lists offline whose own data arrives
 *   B-lxxiii a Core inside its dwell does not withhold the power figures (a partial sum publishes)
 *   B-lxxiv readiness ignores the home Cores at their own reading
 *   B-lxxv  where the bridge books nothing, a marked Core's own measured readings are still cut
 *   B-lxxvi handsBack ignores whether the Core has a reading of its own (a frozen marked Core is handed back)
 *
 * Review round 2 (v1.188.1):
 *   B-lxxvii where the bridge books nothing, a marked Core's own pack meters are not booked (its battery by nobody)
 *   B-lxxviii a window whose only slot row is its start books the slot's held value, not the Core's own readings
 *   B-lxxix a dark slot's gap is never held (each window inside a panel shadow books nothing)
 *   B-lxxx  a held bridge window does not hold the two counters it adds to
 *   B-lxxxi the clamp ignores the slot rows recorded after the watermark (a crash's span is dropped)
 *   B-lxxxii a Core listed by two panels is metered at both slots
 *   B-lxxxiii two listings of a Core are ranked by serial alone (a stale panel's listing is read)
 *   B-lxxxiv every held row of a Core is marked, a pack it no longer carries included
 *   B-lxxxv the rollup marks without the device map
 *   B-lxxxvi with no projection, a pack another chassis carries now is marked too
 *   B-lxxxvii the hand-back does not spend a marker of a pack the Core no longer reports
 *   B-lxxxviii a pack list not yet complete counts as complete (a pack still to report loses its marker)
 *   B-lxxxix the flow sensors keep a frozen Core's held figures (AC Import publishes its held input)
 *   B-xc    a dark slot's AC input is not added to AC Import
 *   B-xci   a dark slot's delivery is not added to Fleet Total Out
 *   B-xcii  a dark slot with no fresh meter does not withhold the flow sensors
 *   B-xciii the MQTT publisher publishes AC Import from the Cores' sums again
 *   B-xciv  /api/ha-state publishes Fleet Total In from the Cores' sums again
 *   B-xcv   a source-set change re-seeds the battery floors at once (a one-poll isConnect flicker resets the counters)
 *   B-xcvi  the Cores that left drop out of the battery sum while the change is pending
 *   B-xcvii the sustained re-seed takes the sum that still carried the Cores that left
 *   B-xcviii the BMS pass reads the live source set only (the pending change is ignored)
 *   B-xcix  a dark slot's gap the gate explains is not held past 10 min (integration review F8)
 *   B-c     the 15-min clamp does not wait for a held panel (a long stall's windows are skipped)
 *   B-ci    the bridge reads the rows only (a held panel's reading is not restated across its gap)
 *   B-cii   the bridge is not told which gaps the gate explains
 *   B-ciii  the accepted roster is not the member set while the panel reads no source set (a boot
 *           with the cloud unreachable carries a former member's orphan rows: +938.8 kWh)
 *   B-civ   the accepted roster is used only while a change is pending (the same)
 *
 * v1.189.1 (the PV-field check on the 2026-10-18 evidence: max(two steps, 15 %), a verdict held an
 * hour or a genuine 2 kWh margin; the power sensors read a present field unchecked):
 *   B-cv    the tolerance has no fraction (two steps alone)
 *   B-cvi   a verdict acts at once (no hold)
 *   B-cvii  a genuine 2 kWh margin waits the hour
 *   B-cviii an absent PV field is published as 0 W
 *   B-cix   the power sensors ignore the verdict in force (a field found short today is read unchecked)
 *   B-cx    slotVerdicts leaves an unchecked field out (the card and the timers disagree with the sensors)
 *   B-cxi   the unchecked field is not added to the power figures
 *   B-cxii  a window with a below candidate pending against a trusted slot books nothing (the hold's energy lost)
 *
 *   node scripts/mutate-energy-core-outage.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EB = resolve(REPO, 'server/src/energyBridge.ts');
const RC = resolve(REPO, 'server/src/recorder.ts');
const PR = resolve(REPO, 'server/src/publishReadiness.ts');
const MEMB = resolve(REPO, 'server/src/shp2Membership.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/energyBridge.test.ts',
  'test/recorderEnergyBridge.test.ts',
  'test/recorderEnergyBridgeTransitions.test.ts',
  'test/energyBridgePublish.test.ts',
  'test/publishReadiness.test.ts',
  'test/lifetimeDipClamp.test.ts',
  'test/energyBridgeOwnReading.test.ts',
  'test/energyBridgeSeams.test.ts',
  'test/panelGapLifetime.test.ts',
  'test/recorderMembershipRollover.test.ts',
  'test/heldGapEnergy.test.ts',
  'test/recorderBootWithoutPanel.test.ts',
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
    find: '              if (handsBack(d, Date.now())) {',
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
    id: 'B-xi. ★★ a panel PV field the check has found short today is used for the power sensors',
    file: EB,
    find: "  if (s.pvW == null || trust === 'below') return 'unbridgeable';",
    to: "  if (s.pvW == null) return 'unbridgeable'; /* MUTANT */",
    why: 'Fleet PV publishes a field demonstrably short of the solar the Core took in, and Battery Net the difference, after the check has said so.',
  },
  {
    id: 'B-xii. ★★★ the rollup judges a window on the panel\'s reading at the instant again',
    file: EB,
    find: '        const wPts = slotPts.get(s) ?? [];\n',
    to: "        if (!s.panelFresh) { win.reason = 'the panel reading is not fresh'; return; } /* MUTANT */\n        const wPts = slotPts.get(s) ?? [];\n",
    why: 'The review defect (round 2): a cloud shadow that latches just before a rollup drops that whole window, the slot rows written before the latch included (3.10 of 3.38 kWh of battery out booked in the hour). A frozen or replayed panel body writes no row (the recorder\'s gate), so every row is a reading.',
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
    find: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && (fb.bridgedSlots > 0 || (fb.ownCores ?? 0) > 0))) && fb.ready;',
    to: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && (fb.bridgedSlots > 0 || (fb.ownCores ?? 0) > 0))); /* MUTANT */',
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
    find: '  const bridged = offlineSinceMs == null ? (isMarked || dpu.online === false) : nowMs - offlineSinceMs >= BRIDGE_DWELL_MS;',
    to: '  const bridged = true; /* MUTANT */',
    why: 'A 6 s /status blip at a rollup activates the bridge: markers, three log lines, and the window\'s battery energy booked beside the BMS.',
  },
  {
    id: 'B-xxvii. ★★★ the bridge\'s window ignores the hand-off instant',
    file: EB,
    find: '      const start = Math.max(since, s.darkSinceMs ?? since);\n      const win: BridgeSlotWindow',
    to: '      const start = since; /* MUTANT */\n      const win: BridgeSlotWindow',
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
    id: 'B-xxxiii. ★★★ the field verdict\'s tolerance is one SoC step',
    file: EB,
    find: "  return fieldWh >= inferredWh - pvFieldTolerance(inferredWh, stepWh) ? 'consistent' : 'below';",
    to: "  return fieldWh >= inferredWh - stepWh ? 'consistent' : 'below'; /* MUTANT */",
    why: 'The 2026-10-18 rule: the bound carries a step of quantization at each end, so an honest field one step short (2.67 vs 2.99 kWh) is revoked and the Now view blanks until dusk.',
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
    find: '    if (since < cutoff && !dark.some(recordedAfter) && !dark.some(heldSince)) since = cutoff;',
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
    find: "        `the panel bridge counted ${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out (AC basis at the slot, or the Core\'s own pack meters where the slot could not be read; already published)`,\n      );\n",
    to: "        `the panel bridge counted ${(b.chargeWh / 1000).toFixed(2)} kWh in / ${(b.dischargeWh / 1000).toFixed(2)} kWh out (AC basis at the slot, or the Core\'s own pack meters where the slot could not be read; already published)`,\n      );\n      if (energyBridge.markersOf(sn).length === 0) energyBridge.clearCore(sn); /* MUTANT */\n",
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
    to: '  return solarPosition(new Date(ms), DEFAULT_SITE_LAT, DEFAULT_SITE_LON).elevation > 0; /* MUTANT */',
    why: 'The review defect: outside Phoenix a local morning takes the night basis (solar booked as battery out) and a local night the inferred one (both power sensors unknown all night).',
  },
  {
    id: 'B-l. ★★★ the bridge\'s site ignores the configured location',
    file: RC,
    find: '    site: () => bridgeSite(siteCoordinates()),',
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
    to: '    const site = { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON }; /* MUTANT */',
    why: 'Outside Phoenix a local morning\'s dark-Core windows take the night basis: the solar they pass to the house books as battery out.',
  },
  {
    id: 'B-lv. ★★ the power sensors\' day/night test ignores the configured site',
    file: EB,
    find: '      return bridgeFleetFlow(online, devices, nowMs, fieldTrust, deps.site(), known, isMarked);',
    to: '      return bridgeFleetFlow(online, devices, nowMs, fieldTrust, { lat: DEFAULT_SITE_LAT, lon: DEFAULT_SITE_LON }, known, isMarked); /* MUTANT */',
    why: 'Outside Phoenix Fleet PV and Battery Net read the PV field through the local night of a Core outage (Phoenix daylight), or unknown where it is absent.',
  },
  {
    id: 'B-lvi. ★★★ a restart ignores the persisted hand-off instant',
    file: EB,
    find: '  const rec = known ? finite(known(src.sn)) : null;',
    to: '  const rec = null as number | null; /* MUTANT */',
    why: 'The review defect: a crash within one rollup of a daylight dark flip steps PV Production down at the first publish after the restart (150-525 Wh), and the bridge books again the battery energy the BMS counted before the flip.',
  },
  {
    id: 'B-lvii. ★★★ the hand-off instant is never persisted',
    file: EB,
    find: '        deps.writeLifetime(bridgeOfflineKey(src.sn), 1, t);',
    to: '        /* MUTANT */',
    why: 'Nothing survives a crash: the restarted process cuts the dark Cores at the watermark (the same step down and double count).',
  },
  {
    id: 'B-lviii. ★★ the hand-off instant outlives the Core\'s return',
    file: EB,
    find: '      offlineAt.delete(sn);\n      deps.deleteLifetime(bridgeOfflineKey(sn));',
    to: '      /* MUTANT */',
    why: 'A Core that came back keeps the instant of an outage that ended; a later outage the add-on did not see starts from it.',
  },
  {
    id: 'B-lix. ★★★ a dark Core with no projection is left out of the contributors',
    file: RC,
    find: '        const o = offline.get(d.sn);\n        if (o) {',
    to: '        const o = offline.get(d.sn);\n        if (o && false) { /* MUTANT */',
    why: 'After a crash restart a dark Core has no projection (no quota is fetched for a device listed offline): the PV it delivered between the last rollup and the flip drops out of the read, and out of the counter for good.',
  },
  {
    id: 'B-lx. ★★ a dark Core with no projection is not cut',
    file: RC,
    find: '          const untilMs = ownEnergyUntil(o, phase);',
    to: '          const untilMs = undefined as number | null | undefined; /* MUTANT */',
    why: 'Its last reading before the flip is held up to 10 min past it (integrateWh\'s tail hold) beside the bridge: counted twice.',
  },
  {
    id: 'B-lxi. ★★★ the bridge\'s window ignores the persisted instant',
    file: EB,
    find: '    const dark = darkHomeSlots(snap.devices, nowMs, known, isMarked);',
    to: '    const dark = darkHomeSlots(snap.devices, nowMs, undefined, isMarked); /* MUTANT */',
    why: 'The review defect: after a crash restart the first bridged window starts at the watermark and books again the battery energy the BMS counted before the flip (125-375 Wh).',
  },
  {
    id: 'B-lxii. ★★★ the recorder\'s cut ignores the persisted instant',
    file: EB,
    find: '      return offlineHomeCores(devices, nowMs, known, isMarked);',
    to: '      return offlineHomeCores(devices, nowMs, undefined, isMarked); /* MUTANT */',
    why: 'The review defect: the first publish after a crash restart drops the PV and AC input the crashed process had shown since the flip (PV Production steps down).',
  },
  {
    id: 'B-lxiii. ★★★ a Core listed online is never dark (the cloud\'s flag decides again)',
    file: EB,
    find: '  if (isMarked ? handsBack(dpu, nowMs) : coreReports(dpu, nowMs)) return null;',
    to: '  if (dpu.online !== false) return null; /* MUTANT */',
    why: 'The review defect: a Core listed online on a frozen meter (a quota that keeps failing, a REST 200 replaying a cached body) or with no projection yet after a restart is neither recorded nor bridged; its slot\'s battery and solar go into no counter, and Battery Net publishes a partial sum or a frozen figure.',
  },
  {
    id: 'B-lxiv. ★★★ a bridged Core hands back on its own reading alone',
    file: EB,
    find: '  if (isMarked ? handsBack(dpu, nowMs) : coreReports(dpu, nowMs)) return null;',
    to: '  if (coreReports(dpu, nowMs)) return null; /* MUTANT */',
    why: 'A bridged Core whose MQTT data comes back while the cloud still lists it offline leaves the bridge, while its packs\' movement is still absorbed for the hand-over: that span is booked by nobody.',
  },
  {
    id: 'B-lxv. ★★ a marked Core\'s dark instant is re-derived from the store\'s clocks',
    file: EB,
    find: '  const t = isMarked ? rec : ownReadingStoppedAt(dpu) ?? rec;',
    to: '  const t = ownReadingStoppedAt(dpu) ?? rec; /* MUTANT */',
    why: 'The instant follows each MQTT delta of a bridged Core still listed offline: each window starts a minute before its end and the rest of the span is booked by nobody.',
  },
  {
    id: 'B-lxvi. ★★ an offline Core\'s dark instant ignores its later content change',
    file: EB,
    find: '  return c == null ? o : Math.max(o, c);',
    to: '  return o; /* MUTANT */',
    why: 'A Core whose MQTT data kept arriving after the offline flip is taken over from the flip, not from its last own reading.',
  },
  {
    id: 'B-lxvii. ★★ an offline Core\'s report from before the flip counts as its own reading',
    file: EB,
    find: '  return o == null || (c != null && c > o);',
    to: '  return true; /* MUTANT */',
    why: 'Its last report before the cloud declared it offline keeps it "reporting" for minutes after the flip: the read path does not cut at the flip.',
  },
  {
    id: 'B-lxviii. ★★★ an online Core with no instant is bridged at once',
    file: EB,
    find: '  const bridged = offlineSinceMs == null ? (isMarked || dpu.online === false) : nowMs - offlineSinceMs >= BRIDGE_DWELL_MS;',
    to: '  const bridged = offlineSinceMs == null ? true : nowMs - offlineSinceMs >= BRIDGE_DWELL_MS; /* MUTANT */',
    why: 'A restart\'s first body only seeds the witness: every live Core would be handed to the bridge for its first seconds, markers written.',
  },
  {
    id: 'B-lxix. ★★★ the first sight of an online Core with no reading is never recorded',
    file: EB,
    find: '          firstSight.set(src.sn, nowMs);',
    to: '          /* MUTANT */',
    why: 'A Core listed online whose quota keeps failing from a restart on is never bridged: its slot\'s energy is booked by nobody and both power figures stay unknown.',
  },
  {
    id: 'B-lxx. ★★★ the hand-off instant is deleted at an online flip, not once the Core reports',
    file: EB,
    find: '      if (dark.has(sn) || devices[sn] == null) continue;',
    to: '      if (devices[sn]?.online !== true) continue; /* MUTANT */',
    why: 'An online flip before the first fresh body drops the instant of a dark span that has not ended; a crash then hands the Core over at the watermark.',
  },
  {
    id: 'B-lxxi. ★★★ the power sensors sum a frozen projection listed online as live',
    file: EB,
    find: '    if (summed) { const f = ownFlow(d); pv -= f.pv; net -= f.net; acIn -= f.acIn; fleetIn -= f.fleetIn; fleetOut -= f.fleetOut; }',
    to: '      /* MUTANT */',
    why: 'The review defect: Battery Net and Fleet PV publish a frozen Core\'s held pack flows beside its slot (HA disagrees with the card and the timers).',
  },
  {
    id: 'B-lxxii. ★★ the power sensors leave out a Core the cloud lists offline whose own data arrives',
    file: EB,
    find: '      if (!summed) { const f = ownFlow(d); pv += f.pv; net += f.net; acIn += f.acIn; fleetIn += f.fleetIn; fleetOut += f.fleetOut; }',
    to: '        /* MUTANT */',
    why: 'Fleet PV drops a Core that is measured, because the cloud lists it offline: a partial sum.',
  },
  {
    id: 'B-lxxiii. ★★★ a Core inside its dwell does not withhold the power figures',
    file: EB,
    find: '    if (!o.bridged && panel.online === true) { pending.push(src.sn as string); ready = false; meterReady = false; }',
    to: '    if (!o.bridged && panel.online === true) { pending.push(src.sn as string); meterReady = false; } /* MUTANT */',
    why: 'The review defect: a Core flipped online by /status before its first quota, or offline inside the dwell, is in neither figure and Battery Net publishes a partial sum as a reading.',
  },
  {
    id: 'B-lxxiv. ★★ readiness ignores the home Cores at their own reading',
    file: PR,
    find: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && (fb.bridgedSlots > 0 || (fb.ownCores ?? 0) > 0))) && fb.ready;',
    to: '  r.flowBridged = fb == null ? r.flow : (r.flow || (membershipKnown && fb.bridgedSlots > 0)) && fb.ready; /* MUTANT */',
    why: 'With every Core listed offline but streaming its own data, both power sensors are withheld though every figure is a reading.',
  },
  {
    id: 'B-lxxv. ★★ where the bridge books nothing, a marked Core\'s own measured readings are still cut',
    file: RC,
    find: '      if (w.own === true) ownInstead.add(w.sn);',
    to: '      /* MUTANT */',
    why: 'The review defect: with the panel reading not fresh, a dark Core\'s measured pv_total / ac_in rows are discarded and nothing is booked in their place.',
  },
  {
    id: 'B-lxxvi. ★★★ handsBack ignores whether the Core has a reading of its own',
    file: EB,
    find: '  return reportsSinceReturn(d) && coreReports(d, nowMs);',
    to: '  return reportsSinceReturn(d); /* MUTANT */',
    why: 'A frozen marked Core counts as handed back: the bridge stops metering it, and register movement without a content change spends the markers and is counted beside the bridge.',
  },
  // ── review round 2 ────────────────────────────────────────────────────────
  {
    id: 'B-lxxvii. ★★★ where the bridge books nothing, a marked Core\'s own pack meters are not booked',
    file: EB,
    find: '      result.chargeWh += inWh;\n      result.dischargeWh += outWh;\n',
    to: '      /* MUTANT */\n',
    why: 'The review defect: a marked Core listed offline with its MQTT data back and the panel reading stale counts its PV, and its battery energy is absorbed and booked by nobody (3.4 kWh an hour at night).',
  },
  {
    id: 'B-lxxviii. ★★ a window whose only slot row is its start books the slot\'s held value, not the Core\'s own readings',
    file: EB,
    find: '        if (ownReading(s) && !wPts.some((p) => p.ts > start)) {',
    to: '        if (false) { /* MUTANT */',
    why: 'By day the first window after the panel goes stale is booked from one held slot row on the inferred basis: the Core\'s own 500 Wh of measured solar is replaced by 125 Wh.',
  },
  {
    id: 'B-lxxix. ★★★ a dark slot\'s gap is never held',
    file: EB,
    find: '      if (!pts.some((p) => p.ts >= start) && !ownReading(s) && last != null && (nowMs - last < INTEGRATE_HEAD_LOOKBACK_MS || deps.heldOpen?.(s.panelSn, last, nowMs) === true)) {',
    to: '      if (false) { /* MUTANT */',
    why: 'Every 5-min window inside a panel cloud shadow books nothing at the slots: the dark Cores\' battery out loses the window for good.',
  },
  {
    id: 'B-lxxx. ★★ a held bridge window does not hold the two counters it adds to',
    file: RC,
    find: '      if (bridgeHeld && bridgeShare) continue;',
    to: '      /* MUTANT */',
    why: 'Grid to Battery Charge and PV Production move on without the window the bridge held: a marked Core whose own readings count next keeps only the second half of the span.',
  },
  {
    id: 'B-lxxxi. ★★★ the clamp ignores the slot rows recorded after the watermark',
    file: EB,
    find: '    if (since < cutoff && !dark.some(recordedAfter) && !dark.some(heldSince)) since = cutoff;',
    to: '    if (since < cutoff && !dark.some(heldSince)) since = cutoff; /* MUTANT */',
    why: 'The review defect: after a crash and 11 min or more of downtime the slot rows from the last rollup to the crash are never booked (226 Wh of load against 0 Wh bridged).',
  },
  {
    id: 'B-lxxxii. ★★★ a Core listed by two panels is metered at both slots',
    file: EB,
    find: '  for (const { panel, src } of connectedSourceListings(devices, nowMs)) {\n    const o = offlineState(src, devices, nowMs, known, marked);\n    if (!o?.bridged) continue;',
    to: '  for (const { panel, src } of allShp2s(devices).flatMap((panel) => (panel.projection.sources ?? []).filter((src) => src.isConnected && !!src.sn).map((src) => ({ panel, src })))) { /* MUTANT */\n    const o = offlineState(src, devices, nowMs, known, marked);\n    if (!o?.bridged) continue;',
    why: 'The review defect: Battery Net reads 2000 W for one Core delivering 1000 W, and the rollup books both windows into the lifetime rows.',
  },
  {
    id: 'B-lxxxiii. ★★ two listings of a Core are ranked by serial alone',
    file: MEMB,
    find: '    rank(b) - rank(a) || (b.sn === house ? 1 : 0) - (a.sn === house ? 1 : 0) || (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0));',
    to: '    (b.sn === house ? 1 : 0) - (a.sn === house ? 1 : 0) || (a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0)); /* MUTANT */',
    why: 'The stale panel\'s listing is read and the live one dropped: the Core is unbridgeable and both power figures read unknown.',
  },
  {
    id: 'B-lxxxiv. ★★★ every held row of a Core is marked, a pack it no longer carries included',
    file: EB,
    find: '  if (present) return out.filter((k) => present.has(k));',
    to: '  if (present) return out; /* MUTANT */',
    why: 'The review defect: a replaced pack\'s row gets a marker no register can spend; the Core stays marked for good and a 6 s blip is bridged at once.',
  },
  {
    id: 'B-lxxxv. ★★ the rollup marks without the device map',
    file: EB,
    find: '      for (const pk of heldPackKeysOf(s.sn, lifetimeKeys, snap.devices)) {',
    to: '      for (const pk of heldPackKeysOf(s.sn, lifetimeKeys)) { /* MUTANT */',
    why: 'The marking ignores the packs the projection carries: the replaced pack\'s row is marked again.',
  },
  {
    id: 'B-lxxxvi. ★★ with no projection, a pack another chassis carries now is marked too',
    file: EB,
    find: '    return c < 0 || !elsewhere.has(k.slice(c + 1));',
    to: '    return true; /* MUTANT */',
    why: 'After a restart while dark, the stale row of a pack that moved to another Core is marked and its marker kept.',
  },
  {
    id: 'B-lxxxvii. ★★★ the hand-back does not spend a marker of a pack the Core no longer reports',
    file: RC,
    find: '        for (const k of gone) energyBridge.clearMarker(k);',
    to: '        /* MUTANT */',
    why: 'A Core dark since a restart (every held row marked) keeps the stale row\'s marker after it hands back.',
  },
  {
    id: 'B-lxxxviii. ★★ a pack list not yet complete counts as complete',
    file: EB,
    find: "  return typeof n === 'number' && Number.isFinite(n) && n > 0 && (d.projection.packs ?? []).length >= n;",
    to: '  return n !== -1; /* MUTANT */',
    why: 'A Core that comes back showing one of its two packs loses the other\'s marker: its jump, when it lands, is counted beside the bridge.',
  },
  {
    id: 'B-lxxxix. ★★★ the flow sensors keep a frozen Core\'s held figures',
    file: EB,
    find: '    if (summed) { const f = ownFlow(d); pv -= f.pv; net -= f.net; acIn -= f.acIn; fleetIn -= f.fleetIn; fleetOut -= f.fleetOut; }',
    to: '    if (summed) { const f = ownFlow(d); pv -= f.pv; net -= f.net; } /* MUTANT */',
    why: 'The review defect: every Core frozen online mid grid-charge keeps AC Import at its held 15 kW while the slots read 0 W.',
  },
  {
    id: 'B-xc. ★★★ a dark slot\'s AC input is not added to AC Import',
    file: EB,
    find: '      acIn += Math.max(0, s.chW);',
    to: '      /* MUTANT */',
    why: 'A force charge through the slots of dark Cores publishes 0 W of AC import.',
  },
  {
    id: 'B-xci. ★★ a dark slot\'s delivery is not added to Fleet Total Out',
    file: EB,
    find: '      fleetOut += Math.max(0, -s.chW);',
    to: '      /* MUTANT */',
    why: 'The dark Cores carrying the house publish 0 W out.',
  },
  {
    id: 'B-xcii. ★★ a dark slot with no fresh meter does not withhold the flow sensors',
    file: EB,
    find: '    } else {\n      meterReady = false;\n    }',
    to: '    } else {\n      /* MUTANT */\n    }',
    why: 'A stale panel publishes a partial sum as AC Import.',
  },
  {
    id: 'B-xciii. ★★★ the MQTT publisher publishes AC Import from the Cores\' sums again',
    file: MQ,
    find: '      ac_import_watts: bridged.acIn == null ? null : Math.round(bridged.acIn),',
    to: '      ac_import_watts: Math.round(acIn), /* MUTANT */',
    why: 'The bridged figure is computed and the sensor ignores it: 15 kW of held AC input.',
  },
  {
    id: 'B-xciv. ★★ /api/ha-state publishes Fleet Total In from the Cores\' sums again',
    file: IDX,
    find: '    fleet_total_in_watts: bridged.fleetIn == null ? null : Math.round(bridged.fleetIn),',
    to: '    fleet_total_in_watts: Math.round(fleetIn), /* MUTANT */',
    why: 'A frozen Core\'s held input is published as live.',
  },
  {
    id: 'B-xcv. ★★★ a source-set change re-seeds the battery floors at once',
    file: RC,
    find: '    const sustained = pendingMembership != null && pendingMembership.rollups >= MEMBERSHIP_SUSTAINED_ROLLUPS;',
    to: '    const sustained = pendingMembership != null; /* MUTANT */',
    why: 'The review defect (pre-existing since v1.96.0): one rollup with a dark Core\'s slot reading isConnect = 0 steps Battery Energy In and Out down by a third (a meter reset), then back up.',
  },
  {
    id: 'B-xcvi. ★★★ the Cores that left drop out of the battery sum while the change is pending',
    file: RC,
    find: '    if (pendingMembership == null) return live;',
    to: '    if (pendingMembership == null || (true as boolean)) return live; /* MUTANT */',
    why: 'A two-rollup flicker after hours of discharge opens a gap over the v1.98.0 threshold: that re-seed steps the counters down instead.',
  },
  {
    id: 'B-xcvii. ★★ the sustained re-seed takes the sum that still carried the Cores that left',
    file: RC,
    find: '        pendingMembership = null;\n        bms = computeBmsBatteryTotals(snap);',
    to: '        pendingMembership = null; /* MUTANT */',
    why: 'A real rollover re-seeds to the old pool\'s sum: the counters stay pinned above the new pool, the v1.96.0 freeze.',
  },
  {
    id: 'B-xcviii. ★★ the BMS pass reads the live source set only',
    file: RC,
    find: '    const sourceSns = bmsMembersOf(snap);',
    to: '    const sourceSns = sourceSnsOf(snap); /* MUTANT */',
    why: 'The pending change is ignored where it matters: a two-rollup flicker trips the v1.98.0 floor-gap re-seed.',
  },
  // ── integration review F8: a held panel's gap past 10 min ──
  {
    id: 'B-xcix. ★★★ a dark slot\'s gap the gate explains is not held past 10 min',
    file: EB,
    find: '      if (!pts.some((p) => p.ts >= start) && !ownReading(s) && last != null && (nowMs - last < INTEGRATE_HEAD_LOOKBACK_MS || deps.heldOpen?.(s.panelSn, last, nowMs) === true)) {',
    to: '      if (!pts.some((p) => p.ts >= start) && !ownReading(s) && last != null && nowMs - last < INTEGRATE_HEAD_LOOKBACK_MS) { /* MUTANT */',
    why: 'Every Core dark: a 12-poll replay books nothing at the slots for the windows inside it (about 0.5 kWh of battery out an hour at 3.4 kW).',
  },
  {
    id: 'B-c. ★★ the 15-min clamp does not wait for a held panel',
    file: EB,
    find: '    if (since < cutoff && !dark.some(recordedAfter) && !dark.some(heldSince)) since = cutoff;',
    to: '    if (since < cutoff && !dark.some(recordedAfter)) since = cutoff; /* MUTANT */',
    why: 'A held window older than 15 min is clamped forward past the gap\'s start, and the battery out of a 25-poll stall is lost.',
  },
  {
    id: 'B-ci. ★★★ the bridge reads the rows only',
    file: RC,
    find: '    query: energyPoints,',
    to: '    query: (sn, metric, sinceMs, untilMs) => queryStmt.all(sn, metric, sinceMs, untilMs) as Array<{ ts: number; value: number }>, /* MUTANT */',
    why: 'The bridge holds the window but the gap has no row to integrate across: the windows inside it book nothing at the slots.',
  },
  {
    id: 'B-cii. ★★★ the bridge is not told which gaps the gate explains',
    file: RC,
    find: '    heldOpen: (sn, fromMs, nowMs) => heldGaps.open(sn, fromMs, nowMs),',
    to: '    /* MUTANT */',
    why: 'Past 10 min the bridge books a window inside the panel\'s gap as empty before the gap ends.',
  },
  // ── integration round 3: a boot while the panel reads no source set ──
  {
    id: 'B-ciii. ★★★ the accepted roster is not the member set while the panel reads no source set',
    file: RC,
    find: '    if (live.size === 0) return new Set(accepted);\n',
    to: '    /* MUTANT */\n',
    why: 'A boot with the cloud unreachable (or the panel quota failing) carries every persisted held pack row, a former member\'s orphans included: +938.8 kWh Battery Energy In on the first publish, then the v1.98.0 re-seed steps it back down (a meter reset in Home Assistant).',
  },
  {
    id: 'B-civ. ★★ the accepted roster joins the live set only while a change is pending, as before',
    file: RC,
    find: '    if (live.size === 0) return new Set(accepted);\n',
    to: '    if (live.size === 0 && pendingMembership != null) return new Set(accepted); /* MUTANT */\n',
    why: 'An empty source set is never a pending change (the rollup reads it as no change), so the same boot carries the orphans.',
  },
  // v1.189.1 — the PV-field check against the inferred bound, re-tuned on the 2026-10-18 evidence.
  {
    id: 'B-cv. ★★★ the tolerance has no fraction (two steps alone)',
    file: EB,
    find: '  return Math.max(BRIDGE_PV_TOLERANCE_STEPS * stepWh, BRIDGE_PV_TOLERANCE_FRACTION * inferredWh);',
    to: '  return BRIDGE_PV_TOLERANCE_STEPS * stepWh; /* MUTANT */',
    why: 'An honest field 8 % under a 10 kWh bound (2.7 steps on 2026-10-18) is revoked in the afternoon.',
  },
  {
    id: 'B-cvi. ★★★ a verdict acts at once (no hold)',
    file: EB,
    find: '  if (nowMs - sinceMs >= BRIDGE_PV_VERDICT_HOLD_MS) return true;',
    to: '  return true; /* MUTANT */',
    why: 'A field that lags the meter across a ramp, or one window the bound jumps ahead of, revokes the trust and the sensors blank for the day.',
  },
  {
    id: 'B-cvii. ★★ a genuine 2 kWh margin waits the hour',
    file: EB,
    find: "  return verdict === 'below' ? margin <= -BRIDGE_PV_GENUINE_WH : margin >= BRIDGE_PV_GENUINE_WH;",
    to: '  return false; /* MUTANT */',
    why: 'A field reading 0 W under a 2.3 kWh charge is published unchecked for an hour before it is refused.',
  },
  {
    id: 'B-cviii. ★★★ an absent PV field is published as 0 W',
    file: EB,
    find: "  if (s.pvW == null || trust === 'below') return 'unbridgeable';\n  return trust === true ? 'measured' : 'unchecked';",
    to: "  if (trust === 'below') return 'unbridgeable'; /* MUTANT */\n  return trust === true ? 'measured' : 'unchecked';",
    why: 'With no field at all Fleet PV publishes a made-up figure and Battery Net the slot\'s whole output.',
  },
  {
    id: 'B-cix. ★★ the power sensors ignore the verdict in force (a field found short today is read unchecked)',
    file: EB,
    find: "    for (const [k, c] of checks) if (k.startsWith(prefix) && c.verdict === 'below') return 'below';",
    to: '    /* MUTANT */',
    why: 'After the check has refused the field the sensors go on publishing it.',
  },
  {
    id: 'B-cx. ★★ slotVerdicts leaves an unchecked field out',
    file: EB,
    find: "  for (const s of flow.slots) if ((s.basis === 'measured' || s.basis === 'unchecked') && s.pvW != null) measuredPvW.set(slotKey(s.panelSn, s.slot), s.pvW);",
    to: "  for (const s of flow.slots) if (s.basis === 'measured' && s.pvW != null) measuredPvW.set(slotKey(s.panelSn, s.slot), s.pvW); /* MUTANT */",
    why: 'Fleet PV publishes the slot\'s solar while the energy flow card reads Solar "—" and the timers show a time to empty beside a Battery Net charge.',
  },
  {
    id: 'B-cxi. ★★★ the unchecked field is not added to the power figures',
    file: EB,
    find: "    const p = basis === 'measured' || basis === 'unchecked' ? (s.pvW as number) : 0;",
    to: "    const p = basis === 'measured' ? (s.pvW as number) : 0; /* MUTANT */",
    why: 'Before its check the field publishes as 0 W of solar and Battery Net as the slot\'s whole output — the made-up figure the unchecked basis must not be.',
  },
  {
    id: 'B-cxii. ★★ a window with a below candidate pending against a trusted slot books nothing',
    file: EB,
    find: "          if (fieldWh != null && isTrusted(s.panelSn, s.slot)) {\n            win.basis = 'measured';\n            pvWh = fieldWh;\n          } else if (step.pvWh != null) {",
    to: "          if (fieldWh != null && isTrusted(s.panelSn, s.slot) && checks.get(inferKey)?.candidate?.verdict !== 'below') { /* MUTANT */\n            win.basis = 'measured';\n            pvWh = fieldWh;\n          } else if (step.pvWh != null && checks.get(inferKey)?.candidate?.verdict !== 'below') {",
    why: 'A trusted field found short is booked on the measured basis until the verdict acts (documented: up to about max(the tolerance, 2 kWh) of shortfall per slot). Taking the window away from the field while the candidate is pending without booking the inferred basis instead leaves the slot unbridgeable for the hold: an hour of the house running on the Core, booked by nobody.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energy-core-outage', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
