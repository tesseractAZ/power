#!/usr/bin/env node
/**
 * mutate-lifetime-monotone.mjs — v1.193.0: every lifetime counter the add-on publishes only rises.
 * Home Assistant reads a reading below 0.9 × the previous one as a meter reset and books the whole
 * new reading again, and a step up as energy. The battery floors still re-seed when the pool
 * changes (a Core leaving or joining, the v1.98.0 floor-gap repair); the published counters continue
 * from their last values, the difference carried as a basis shift committed with the floors. A Core
 * that joins counts from the re-seed. Every counter holds a drop up to 5 kWh and continues from the
 * last value past it. A read integrates the panel series up to the newest reading only.
 *
 *   Re-seed    L-i..L-iii   (the membership shift, the floor-gap shift, the shift's sign)
 *              L-xiii..L-xv (the accepted set moves before the recompute; both shifts start from the
 *                            floors as the rollup ratchets them)
 *   Joiners    L-v          (summed before the re-seed)
 *   Guard      L-iv, L-viii, L-ix (a large drop passes; the hold is 50 Wh on the watt keys; a held
 *                            dip is published)
 *   Persist    L-vi, L-x..L-xii, L-xvi, L-xvii (the shifts loaded at boot; the floors commit with
 *                            their shifts; the roster file follows the commit; the read path takes
 *                            the in-memory floors; the rebase is written at once; the sidecar is
 *                            renamed into place)
 *   Read path  L-vii        (extrapolated to the read instant)
 *   Payload    L-xviii      (the MQTT state's lifetime read is unguarded)
 *
 *   node scripts/mutate-lifetime-monotone.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REC = resolve(REPO, 'server/src/recorder.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
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
    find: '      const g = guardLifetimeEmit(hw, readWh);',
    to: "      const g = guardLifetimeEmit(hw, readWh, key.startsWith('fleet_battery') ? LIFETIME_HOLD_DIP_WH : 50); /* MUTANT */",
    why: 'A 538 Wh dip across a restart is rebased instead of held: when the row catches up the energy is published twice.',
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
    find: "      for (const [key, d] of basisDirty) basisUpsertStmt.run(key, basisShift.get(key) ?? 0, d.ts, d.reason);\n      db.prepare('COMMIT').run();",
    to: "      db.prepare('COMMIT').run(); /* MUTANT */\n      for (const [key, d] of basisDirty) basisUpsertStmt.run(key, basisShift.get(key) ?? 0, d.ts, d.reason);",
    why: 'A failed shift write leaves a re-seeded floor with the old shift: the next process publishes the step.',
  },
  {
    id: 'L-xi. ★★ the roster file is written whether or not the floors committed',
    file: REC,
    find: '    if (writeBatteryFloors(now) && membershipFileFp !== null) {',
    to: '    if ((writeBatteryFloors(now) || true) && membershipFileFp !== null) { /* MUTANT */',
    why: 'After a failed commit the next process reads the new roster against the old floors: no re-seed, a frozen counter.',
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
    find: '        writeBasisDirty();',
    to: '        /* MUTANT */',
    why: 'A crash before the next rollup loses the shift: the next process rebases again from a stale high-water.',
  },
  {
    id: 'L-xvii. ★★ the high-water sidecar is written in place',
    file: REC,
    find: '      writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(lifetimeEmitHighWater)), { mode: 0o644 });\n      renameSync(tmpPath, emitHighWaterPath);',
    to: '      writeFileSync(emitHighWaterPath, JSON.stringify(Object.fromEntries(lifetimeEmitHighWater)), { mode: 0o644 }); /* MUTANT */',
    why: 'A crash mid-write leaves a torn file, read as an empty map: the guard is blind on the next boot and a drop passes as a meter reset.',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-lifetime-monotone', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
