#!/usr/bin/env node
/**
 * mutate-lifetime-monotone.mjs — v1.193.0: every lifetime counter the add-on publishes only rises.
 * Home Assistant reads a reading below 0.9 × the previous one as a meter reset and books the whole
 * new reading again, and a step up as energy. The battery floors still re-seed when the pool
 * changes (a Core leaving or joining, the v1.98.0 floor-gap repair); the published counters continue
 * from their last values, the difference carried as a basis shift committed with the floors. A Core
 * that joins counts from the re-seed. Every counter holds a drop up to 5 kWh and continues from the
 * last value past it, and takes that continuation back when the drop comes back. A read integrates
 * the panel series up to the newest reading only.
 *
 *   Re-seed    L-i..L-iii   (the membership shift, the floor-gap shift, the shift's sign)
 *              L-xiii..L-xv (the accepted set moves before the recompute; both shifts start from the
 *                            floors as the rollup ratchets them)
 *              L-xxv        (the floor-gap shift carries Battery Energy Out too)
 *   Joiners    L-v          (summed before the re-seed)
 *   Guard      L-iv, L-viii, L-ix (a large drop passes; the hold is 50 Wh on the watt keys; a held
 *                            dip is published)
 *              L-xxxi..L-xxxvii (a drop that comes back is taken back: at most the amount owed,
 *                            only a return-sized rise; the rebase is owed, the read passes it, and
 *                            it is written and loaded across a restart)
 *   Persist    L-vi, L-x..L-xii, L-xvi, L-xvii (the shifts loaded at boot; the floors commit with
 *                            their shifts; the roster file follows the commit; the read path takes
 *                            the in-memory floors; the rebase is written at once; the sidecar is
 *                            renamed into place)
 *              L-xix..L-xxiv, L-xxvi (the accepted roster commits with the floors and is read from
 *                            the row; a stale or unwritten file is rewritten; a rebase writes no
 *                            battery shift on its own; the battery pending starts from the in-memory
 *                            floor; the worker adds the shift)
 *   Read path  L-vii        (extrapolated to the read instant)
 *   Payload    L-xviii, L-xxvii, L-xxviii (the MQTT state's lifetime read, its persisted keys and
 *                            /api/ha-state's read are guarded)
 *              L-xxix, L-xxx (the baseline deficit is measured, and the endpoint uses it)
 *
 *   node scripts/mutate-lifetime-monotone.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REC = resolve(REPO, 'server/src/recorder.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
const RR = resolve(REPO, 'server/src/readRecorder.ts');
const FMT = resolve(REPO, 'server/src/haPayloadFmt.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/lifetimeEmitGuard.test.ts',
  'test/recorderEmitHighwater.test.ts',
  'test/recorderMembershipRollover.test.ts',
  'test/recorderFloorGapInvariant.test.ts',
  'test/recorderPoolContinuity.test.ts',
  'test/recorderLifetimeReadMonotone.test.ts',
  'test/recorderBootWithoutPanel.test.ts',
  'test/haPayloadFmt.test.ts',
  'test/analyticsWorker.test.ts',
  'test/recorderLifetimeKeys.test.ts',
];

const MUTANTS = [
  /* ── the re-seeds carry the published counters ── */
  {
    id: 'L-i. ★★★ the membership re-seed takes no basis shift',
    file: REC,
    find: "        const shifted = shiftBattery(c0 - bmsChargeFloor, d0 - bmsDischargeFloor, now, 'membership change');",
    to: "        const shifted = '(MUTANT)'; /* MUTANT */",
    why: 'A sustained leave publishes the new pool\'s 4,096 Wh after 8,192 (Home Assistant: a meter reset, 4,096 Wh booked again); a rejoin steps up +6,144 Wh.',
  },
  {
    id: 'L-ii. ★★★ the floor-gap re-seed takes no basis shift',
    file: REC,
    find: "      const shifted = shiftBattery(c0 - bmsChargeFloor, d0 - bmsDischargeFloor, now, 'floor gap');",
    to: "      const shifted = '(MUTANT)'; /* MUTANT */",
    why: 'The v1.98.0 repair steps Battery Energy In from the peak down to the live sum: the meter reset the repair was never meant to cause.',
  },
  {
    id: 'L-iii. ★★★ the membership shift has its sign flipped',
    file: REC,
    find: "        const shifted = shiftBattery(c0 - bmsChargeFloor, d0 - bmsDischargeFloor, now, 'membership change');",
    to: "        const shifted = shiftBattery(bmsChargeFloor - c0, bmsDischargeFloor - d0, now, 'membership change'); /* MUTANT */",
    why: 'The leave publishes 0 Wh; only the guard\'s backstop (a WARN for an unexplained drop) catches it, and a rejoin doubles the step up.',
  },
  {
    id: 'L-xiii. ★★ the accepted set moves after the recompute',
    file: REC,
    find: '        bmsMembershipFp = membershipFp;\n        pendingMembership = null;\n        bms = computeBmsBatteryTotals(snap);',
    to: '        pendingMembership = null;\n        bms = computeBmsBatteryTotals(snap);\n        bmsMembershipFp = membershipFp; /* MUTANT */',
    why: 'The re-seed recomputes over the OLD set: the floors stay on the old pool and the counters freeze until the live sum climbs back (the v1.96.0 freeze).',
  },
  {
    id: 'L-xiv. ★★ the membership shift starts from the floor before this rollup\'s ratchet',
    file: REC,
    find: '        const c0 = Math.max(bmsChargeFloor, bms.chargeWh), d0 = Math.max(bmsDischargeFloor, bms.dischargeWh);',
    to: '        const c0 = bmsChargeFloor, d0 = bmsDischargeFloor; /* MUTANT */',
    why: 'Energy the old pool moved since the last rollup (already published as pending) is taken back: the guard holds the counter flat until it is re-earned.',
  },
  {
    id: 'L-xv. ★★ the floor-gap shift starts from the floor before this rollup\'s ratchet',
    file: REC,
    find: '      const c0 = Math.max(bmsChargeFloor, bms.chargeWh), d0 = Math.max(bmsDischargeFloor, bms.dischargeWh);\n      bmsChargeFloor = bms.chargeWh;',
    to: '      const c0 = bmsChargeFloor, d0 = bmsDischargeFloor; /* MUTANT */\n      bmsChargeFloor = bms.chargeWh;',
    why: 'A counter with no gap (Battery Energy Out advancing past its floor) is shifted negative: its pending since the last rollup is taken back.',
  },
  /* ── joiners ── */
  {
    id: 'L-v. ★★★ a joining Core is summed before the re-seed',
    file: REC,
    find: '    return new Set(accepted);',
    to: '    return new Set([...live, ...accepted]); /* MUTANT */',
    why: 'The read at a rejoin publishes the Core\'s packs\' whole history since their baselines, bench cycling included: +6,144 Wh in one read on the test plant.',
  },
  /* ── the guard ── */
  {
    id: 'L-iv. ★★★ the guard passes a large drop through',
    file: REC,
    find: "  return dip <= holdWh ? { emitWh: hw, rebaseWh: 0, verdict: 'held' } : { emitWh: hw, rebaseWh: dip, verdict: 'rebased' };",
    to: "  return dip <= holdWh ? { emitWh: hw, rebaseWh: 0, verdict: 'held' } : { emitWh: totalWh, rebaseWh: 0, verdict: 'rise' }; /* MUTANT */",
    why: 'A replaced database publishes 100 Wh after 269.5 kWh: Home Assistant\'s meter reset (the v0.15.14 clamp\'s "genuine reset").',
  },
  {
    id: 'L-viii. ★★ the hold is 50 Wh on the watt keys again',
    file: REC,
    find: '      const g = guardLifetimeEmit(hw, readWh, LIFETIME_HOLD_DIP_WH, basisOwed.get(key) ?? 0);',
    to: "      const g = guardLifetimeEmit(hw, readWh, key.startsWith('fleet_battery') ? LIFETIME_HOLD_DIP_WH : 50, basisOwed.get(key) ?? 0); /* MUTANT */",
    why: 'A 538 Wh dip across a restart is rebased instead of held: when the row catches up the energy is published twice.',
  },
  /* ── an unexplained drop that comes back is taken back (the 2026-06-08 hour) ── */
  {
    id: 'L-xxxi. ★★★ a drop that comes back is published on top of its shift',
    file: REC,
    find: '    if (owed > 0 && rise > holdWh && rise >= owed * LIFETIME_RETURN_SHARE) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A counter that reads 0 for an hour and then its old value publishes twice its value: Home Assistant books the whole counter again (PV +808.6 kWh on 2026-06-08).',
  },
  {
    id: 'L-xxxii. ★★ the take-back takes the whole rise, not at most the amount owed',
    file: REC,
    find: '      const back = Math.min(owed, rise);',
    to: '      const back = rise; /* MUTANT */',
    why: 'A return with new energy behind it loses that energy: owed 10 kWh, a 30 kWh rise publishes nothing new instead of 20 kWh.',
  },
  {
    id: 'L-xxxiii. ★★ any rise over the hold is a return, whatever is owed',
    file: REC,
    find: '    if (owed > 0 && rise > holdWh && rise >= owed * LIFETIME_RETURN_SHARE) {',
    to: '    if (owed > 0 && rise > holdWh) { /* MUTANT */',
    why: 'Real energy after a replaced database (269 kWh owed for good) is taken back 5 kWh at a time: the counter stalls.',
  },
  {
    id: 'L-xxxiv. ★★★ the rebase is not owed',
    file: REC,
    find: "        shift = addBasisShift(key, g.rebaseWh, now, 'unexplained drop', g.rebaseWh);",
    to: "        shift = addBasisShift(key, g.rebaseWh, now, 'unexplained drop'); /* MUTANT */",
    why: 'The guard is right and the recorder never feeds it: the drop that comes back is published twice.',
  },
  {
    id: 'L-xxxv. ★★★ the read passes nothing owed to the guard',
    file: REC,
    find: '      const g = guardLifetimeEmit(hw, readWh, LIFETIME_HOLD_DIP_WH, basisOwed.get(key) ?? 0);',
    to: '      const g = guardLifetimeEmit(hw, readWh); /* MUTANT */',
    why: 'The amount owed is kept and written, and the guard never sees it: the drop that comes back is published twice.',
  },
  {
    id: 'L-xxxvi. ★★★ the amount owed is not loaded at boot',
    file: REC,
    find: '        if (Number.isFinite(r.owed_wh) && r.owed_wh > 0) basisOwed.set(r.metric_key, r.owed_wh);',
    to: '        /* MUTANT */',
    why: 'A drop before a restart that comes back after it is published twice.',
  },
  {
    id: 'L-xxxvii. ★★★ the amount owed is written as 0',
    file: REC,
    find: '    basisUpsertStmt.run(key, basisShift.get(key) ?? 0, d.ts, d.reason, basisOwed.get(key) ?? 0);',
    to: '    basisUpsertStmt.run(key, basisShift.get(key) ?? 0, d.ts, d.reason, 0); /* MUTANT */',
    why: 'The same, across a restart: the next process loads nothing owed.',
  },
  {
    id: 'L-ix. ★★★ a held dip is published',
    file: REC,
    find: "  return dip <= holdWh ? { emitWh: hw, rebaseWh: 0, verdict: 'held' } : { emitWh: hw, rebaseWh: dip, verdict: 'rebased' };",
    to: "  return dip <= holdWh ? { emitWh: totalWh, rebaseWh: 0, verdict: 'held' } : { emitWh: hw, rebaseWh: dip, verdict: 'rebased' }; /* MUTANT */",
    why: 'The v0.15.14 micro-dips reach Home Assistant again ("not strictly increasing", a negative hour).',
  },
  /* ── persistence ── */
  {
    id: 'L-vi. ★★★ the basis shifts are not loaded at boot',
    file: REC,
    find: '        if (Number.isFinite(r.shift_wh)) m.set(r.metric_key, r.shift_wh);',
    to: '        /* MUTANT */',
    why: 'The first read after a restart publishes the row alone: 11,776 Wh after 9,728 on the test plant (a step up booked as energy).',
  },
  {
    id: 'L-x. ★★★ the floors commit before their shifts are written',
    file: REC,
    find: "      for (const [key, d] of basisDirty) upsertBasis(key, d);\n      db.prepare('COMMIT').run();",
    to: "      db.prepare('COMMIT').run(); /* MUTANT */\n      for (const [key, d] of basisDirty) upsertBasis(key, d);",
    why: 'A failed shift write leaves a re-seeded floor with the old shift: the next process publishes the step.',
  },
  {
    id: 'L-xi. ★★ the roster file is written whether or not the floors committed',
    file: REC,
    find: '    if (writeBatteryFloors(now) && membershipFileFp !== null) {',
    to: '    if ((writeBatteryFloors(now) || true) && membershipFileFp !== null) { /* MUTANT */',
    why: 'After a failed commit the file names the new roster while the floors are the old pool\'s: a release before v1.193.0 (a rollback) reads it, skips the re-seed and freezes the counters.',
  },
  {
    id: 'L-xii. ★★ the read path takes the battery floor from its row',
    file: REC,
    find: "      if (key === 'fleet_battery_charge_wh') persistedWh = bmsChargeFloor + bridgeTotals.chargeWh;",
    to: "      if (key === 'fleet_battery_charge_wh') persistedWh = prev.wh + bridgeTotals.chargeWh; /* MUTANT */",
    why: 'After a failed write the old row pairs with the new shift: Battery Energy In steps up by the shift (16,896 Wh after 9,728).',
  },
  {
    id: 'L-xvi. ★★ the guard\'s rebase waits for the next rollup to be written',
    file: REC,
    find: "        shift = addBasisShift(key, g.rebaseWh, now, 'unexplained drop', g.rebaseWh);\n        writeBasisDirty();",
    to: "        shift = addBasisShift(key, g.rebaseWh, now, 'unexplained drop', g.rebaseWh);\n        /* MUTANT */",
    why: 'A crash before the next rollup loses the shift: the next process rebases again from a stale high-water.',
  },
  {
    id: 'L-xvii. ★★ the high-water sidecar is written in place',
    file: REC,
    find: '      writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(lifetimeEmitHighWater)), { mode: 0o644 });\n      renameSync(tmpPath, emitHighWaterPath);',
    to: '      writeFileSync(emitHighWaterPath, JSON.stringify(Object.fromEntries(lifetimeEmitHighWater)), { mode: 0o644 }); /* MUTANT */',
    why: 'A crash mid-write leaves a torn file, read as an empty map: the guard is blind on the next boot and a drop passes as a meter reset.',
  },
  {
    id: 'L-xix. ★★★ the accepted roster is not written in the floors\' transaction',
    file: REC,
    find: '      if (bmsMembershipFp !== null) membershipRowUpsertStmt.run(bmsMembershipFp, ts);',
    to: '      /* MUTANT */',
    why: 'The roster lives in the file alone, written after the commit: a crash in between leaves the Core that left in it, and the next process sums its held packs again over the committed floor (+7,168 Wh on the test plant) and shifts them a second time.',
  },
  {
    id: 'L-xx. ★★★ the boot reads the roster file before the committed row',
    file: REC,
    find: '  let bmsMembershipFp: string | null = membershipRowAtBoot ?? membershipFileAtBoot;',
    to: '  let bmsMembershipFp: string | null = membershipFileAtBoot ?? membershipRowAtBoot; /* MUTANT */',
    why: 'A stale file (its write lost after the commit) is the roster again: the Core that left is summed over the committed floor, +7,168 Wh in one read.',
  },
  {
    id: 'L-xxi. ★ a stale roster file is never rewritten',
    file: REC,
    find: '  let membershipFileFp: string | null = membershipRowAtBoot !== null && membershipFileAtBoot !== membershipRowAtBoot ? membershipRowAtBoot : null;',
    to: '  let membershipFileFp: string | null = null; /* MUTANT */',
    why: 'The file keeps the old roster until the next pool change: a rollback to a release before v1.193.0 reads it against floors seeded for another set.',
  },
  {
    id: 'L-xxii. ★ a failed write of the roster file is not retried',
    file: REC,
    find: "        writeFileSync(BMS_MEMBERSHIP_PATH, JSON.stringify({ fp: membershipFileFp, at: new Date(now).toISOString() }), { mode: 0o644 });\n        membershipFileFp = null;\n      } catch {",
    to: "        writeFileSync(BMS_MEMBERSHIP_PATH, JSON.stringify({ fp: membershipFileFp, at: new Date(now).toISOString() }), { mode: 0o644 });\n      } catch {\n      } finally { membershipFileFp = null; /* MUTANT */",
    why: 'One failed write leaves the file behind the committed roster for good (a rollback reads it).',
  },
  {
    id: 'L-xxiii. ★★★ a rebase at a read writes the battery shifts on their own',
    file: REC,
    find: '        if (FLOOR_SHIFT_KEYS.has(key)) continue;',
    to: '        /* MUTANT */',
    why: 'After a failed floor commit the battery shift holds the re-seed: written alone it pairs the old floor row with the new shift, a step at the next process (the old floor less the joiner\'s history: a rebase and a WARN; after a leave, a step up booked as energy).',
  },
  {
    id: 'L-xxiv. ★★ the battery pending starts from the floor row',
    file: REC,
    find: "        const persisted = key === 'fleet_battery_charge_wh' ? bmsChargeFloor : bmsDischargeFloor;",
    to: '        const persisted = prev.wh; /* MUTANT */',
    why: 'After a failed commit of a rejoin re-seed the floor rose in memory only: the pending over the stale row adds the joiner\'s history, 16,896 Wh after 9,728 (L-xii pins the other half of the pair).',
  },
  {
    id: 'L-xxv. ★★ the floor-gap re-seed shifts Battery Energy In alone',
    file: REC,
    find: "      const shifted = shiftBattery(c0 - bmsChargeFloor, d0 - bmsDischargeFloor, now, 'floor gap');",
    to: "      const shifted = shiftBattery(c0 - bmsChargeFloor, 0, now, 'floor gap'); /* MUTANT */",
    why: 'Battery Energy Out steps down to the live sum and only the guard\'s backstop catches it: a WARN for an unexplained drop and a write outside the floors\' commit; a step under 5 kWh is held, that much energy lost.',
  },
  {
    id: 'L-xxvi. ★★ the worker\'s totals leave out the basis shift',
    file: RR,
    find: '        out[r.metric_key] = { persistedWh: r.wh + shiftWh, pendingWh: 0, watermarkMs: r.last_integrated_ts, shiftWh };',
    to: '        out[r.metric_key] = { persistedWh: r.wh, pendingWh: 0, watermarkMs: r.last_integrated_ts, shiftWh }; /* MUTANT */',
    why: 'The lifetime carbon figures are computed from a PV total other than the one published, short by its shift.',
  },
  /* ── the read path ── */
  {
    id: 'L-vii. ★★★ a read extrapolates the newest reading to the read instant again',
    file: REC,
    find: '          if (readUntil > watermark) pendingWh += integrateWh(pts, watermark, readUntil).wh;',
    to: '          pendingWh += integrateWh(pts, watermark, until).wh; /* MUTANT */',
    why: 'The 9 -> 1 kW read dips 100 Wh and a 10-min silence at 19.2 kW 3.2 kWh; the 5 kWh hold hides the dip, so the tests assert the read never needs one.',
  },
  /* ── the payload ── */
  {
    id: 'L-xviii. ★★★ the MQTT state\'s lifetime read is unguarded',
    file: MQ,
    find: '    const lifetime = lifetimeTotalsOrNone(() => {\n      const t = recorder.getLifetimeTotals();\n      lifetimeErrLogged = null;\n      return t;\n    }, (msg) => {',
    to: '    const lifetime = ((read: () => ReturnType<Recorder["getLifetimeTotals"]>, _onError: (msg: string) => void) => read())(() => { /* MUTANT */\n      const t = recorder.getLifetimeTotals();\n      lifetimeErrLogged = null;\n      return t;\n    }, (msg: string) => {',
    why: 'A database error in the lifetime read aborts the whole state payload: the runway and alert counts stop publishing with it.',
  },
  {
    id: 'L-xxvii. ★★★ the MQTT state\'s persisted lifetime keys are read unguarded',
    file: MQ,
    find: '    const lifetimeKeys = lifetimeKeysOrNone(() => {\n      const k = recorder.listLifetimeKeys();',
    to: '    const lifetimeKeys = ((read: () => string[], _onError: (msg: string) => void) => read())(() => { /* MUTANT */\n      const k = recorder.listLifetimeKeys();',
    why: 'The same database error, read again for the circuit fields, aborts the payload the lifetime guard just saved: runway and alert counts with it.',
  },
  {
    id: 'L-xxviii. ★★★ /api/ha-state\'s lifetime read is unguarded',
    file: IDX,
    find: '  const lifetime = lifetimeTotalsOrNone(() => {\n    const t = recorder.getLifetimeTotals();',
    to: '  const lifetime = ((read: () => ReturnType<typeof recorder.getLifetimeTotals>, _onError: (msg: string) => void) => read())(() => { /* MUTANT */\n    const t = recorder.getLifetimeTotals();',
    why: 'A database error in the lifetime read fails the whole /api/ha-state response, its runway and alert fields with it.',
  },
  {
    id: 'L-xxix. ★★ the baseline deficit counts the basis shifts',
    file: FMT,
    find: '    return t ? t.persistedWh - (t.shiftWh ?? 0) + t.pendingWh : null;',
    to: '    return t ? t.persistedWh + t.pendingWh : null; /* MUTANT */',
    why: 'After a pool change the deficit reads the difference of the two shifts as discharge ahead of charge: −1.704 kWh for a measured −0.608.',
  },
  {
    id: 'L-xxx. ★★ /api/lifetime-energy computes the deficit from the published values',
    file: IDX,
    find: '    battery_baseline_deficit_kwh: batteryBaselineDeficitKwh(totals),',
    to: "    battery_baseline_deficit_kwh: totals.fleet_battery_charge_wh && totals.fleet_battery_discharge_wh ? toKwh(totals.fleet_battery_discharge_wh.persistedWh + totals.fleet_battery_discharge_wh.pendingWh - totals.fleet_battery_charge_wh.persistedWh - totals.fleet_battery_charge_wh.pendingWh) : null, /* MUTANT */",
    why: 'The pure helper is right and unused: the endpoint reports the shifts as a deficit (the wire-it-to-production failure).',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-lifetime-monotone', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
