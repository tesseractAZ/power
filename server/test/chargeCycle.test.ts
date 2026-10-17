/**
 * R3 (v1.189.0) — THE CHARGE CYCLE RECORD (chargeCycle.ts).
 *
 * One evening arms a cycle of one or two legs: today's single overnight cost leg, or a winter
 * mid-day cycle's resilience-only overnight BACKUP leg followed by the super off-peak COST leg. Each
 * leg is the per-night actuation record, so every per-night rule holds per leg. The file keeps the
 * active leg at its top level in the shape v1.187 / v1.188 read — a rollback still reverts it —
 * plus the pending legs and a trailing one. One predicate, legResolved, lets the next leg go; the
 * open-item half of it is armFromPlan's own refusal, which arming reads.
 *
 * Covered here: coerce and round trip; rollback against the v1.188.0 code (a vendored copy);
 * legResolved, promotion and `trailing`; armCycle against armFromPlan / armRefusalReason (one leg:
 * identical); the owner's cancel by leg at 22:00, 05:02 and 08:00; status legs[]; drift
 * attribution per leg (one leg: the v1.188 rule, but for R1's foreign-settled night, which is the
 * owner's again; a leg that left the cycle keeps its drift tail); the missed-apply push; the ledger's
 * per-leg columns; and the index.ts wiring (source pins: index.ts is not reachable from a unit test).
 * Nothing here can produce a second leg in the live add-on until the mid-day switch: every cycle it
 * arms is the one-leg overnight cycle, and the one-leg sections pin that it behaves as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  armCycle, asChargeLeg, cancelLeg, carryCeilingPrior, coerceCycle, coerceLegState, cycleDriftLeg, cycleLegsStatus,
  departedAfterStep, forceChargeDriftLeg, recentlyDeparted, type DepartedLeg,
  emptyCycle, emptyLegState, legDriftActive, legFinished, legLedgerFields, legResolved, legStatusState, missedApplyDue,
  missedApplyReason, nextForceChargeOpenMs, onlyForceChargeOffOpen, parseCancelLeg, promoteCycle, serializeCycle, supersededLegs,
  trailingResolved, withLiveTrailing,
  BACKUP_LEDGER_COLUMN, CYCLE_FILE_VERSION, DRIFT_LEAD_MS, DRIFT_TAIL_MS, LEGACY_LEG_FIELDS, MAX_PENDING_LEGS, MISSED_APPLY_FALLBACK_REASON,
  type ChargeCycleState, type ChargeLegState, type LegCandidate,
} from '../src/chargeCycle.js';
import {
  armFromPlan, armOpenItem, armRefusalReason, coerceActuationState, decideActuation, emptyActuationState,
  APPLY_LATE_MS, type ArmablePlan, type NightActuationState,
} from '../src/nightChargeActuator.js';
import { FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS } from '../src/nightForceCharge.js';
import { chooseChargeCycle, nextOnPeakStartMs, resolveCheapWindow } from '../src/chargeWindows.js';
import { buildApsREvModel, rateAt, APS_PERIOD } from '../src/tariff.js';
import { buildNightChargeMissedApply } from '../src/notify.js';
import { CHARGE_CYCLE_LEDGER_SCHEMA } from '../src/recorder.js';
import {
  coerceActuationStateV1188, emptyActuationStateV1188, type NightActuationStateV1188,
} from './fixtures/v1188ActuationRecord.js';

const MIN = 60_000;
const H = 3_600_000;
/** A Phoenix wall-clock instant (UTC−7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const REV = buildApsREvModel({
  confirmed: true, onPeak: { summer: 44.2, winter: 34.82 }, offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 }, superOffPeak: { summer: null, winter: 8.2 },
});

/* ── a two-leg cycle: Sunday 2026-11-15 21:30 arms Monday's backup and mid-day legs ── */
const SUN_2130 = phx(2026, 11, 15, 21, 30);
const DAY = '2026-11-15';
const CYCLE = chooseChargeCycle(REV, SUN_2130, { costWindow: 'super_off_peak', objective: 'cost', costMaxSocPct: 90 });
const BACKUP = { startMs: CYCLE.backup!.startMs, endMs: CYCLE.backup!.endMs };
const COST = { startMs: CYCLE.cost!.startMs, endMs: CYCLE.cost!.endMs };
const PEAK = phx(2026, 11, 16, 16);

const plan = (window: { startMs: number; endMs: number } | null, o: Partial<ArmablePlan> = {}): ArmablePlan => ({
  chargeTonight: true, basisComplete: true, buyKwh: 20, setpointSocPct: 50, costCeilingSocPct: 90, window, ...o,
});
const candidates = (o: { backup?: Partial<ArmablePlan>; cost?: Partial<ArmablePlan> } = {}): LegCandidate[] => [
  { role: 'backup', kind: 'overnight', plan: plan(BACKUP, o.backup), forceChargeEnabled: true, nextOnPeakStartMs: PEAK, announcedLevelPct: 50, announcedExpectedKwh: 2 },
  { role: 'cost', kind: 'super_off_peak', plan: plan(COST, o.cost), forceChargeEnabled: true, nextOnPeakStartMs: PEAK, announcedLevelPct: 90, announcedExpectedKwh: 34 },
];
/** The two-leg cycle as armed at 21:30 (the reserve reads 16). */
function twoLeg(prev: ChargeCycleState = emptyCycle()): ChargeCycleState {
  const r = armCycle(prev, DAY, candidates(), SUN_2130, 16);
  assert.ok(r.cycle, 'the fixture cycle arms');
  return r.cycle!;
}
/** A leg applied at `at` and read back (prior 16). */
const applied = <T extends NightActuationState>(s: T, at = s.windowStartMs!): T => ({
  ...s, applyAttemptedAtMs: at, attemptBaselinePct: 16, appliedAtMs: at, priorReservePct: 16, applyVerifiedAtMs: at + MIN,
});
/** Restored at `at`; read back a minute later unless `verified` is false. */
const reverted = <T extends NightActuationState>(s: T, at = s.windowEndMs!, verified = true): T => ({
  ...s, revertedAtMs: at, revertVerifiedAtMs: verified ? at + MIN : null,
});
/** A force-charge switched ON at 13:00 and OFF at 15:00, OFF not (yet) read back. */
const forceChargeOffOpen = <T extends NightActuationState>(s: T): T => ({
  ...s, forceChargeOnAtMs: s.windowStartMs! + 3 * H, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: s.windowStartMs! + 3 * H + MIN,
  forceChargeOffAtMs: s.windowEndMs!, forceChargeOffLastAttemptMs: s.windowEndMs!, forceChargeOffReason: 'windowEnd',
  forceChargeCeilingAttemptedAtMs: s.windowStartMs! + MIN, forceChargeCeilingPriorPct: 100,
});

/* ══ the file: coerce, round trip, rollback ═══════════════════════════════════════════════════ */

test('★★★ a v1.187 / v1.188 actuation file reads as a one-leg cycle: the record unchanged, the overnight cost leg, nothing pending or trailing', () => {
  const old: NightActuationStateV1188 = {
    ...emptyActuationStateV1188(), day: '2026-10-13', announcedAtMs: phx(2026, 10, 13, 21, 30), targetPct: 50, buyKwh: 40,
    windowStartMs: phx(2026, 10, 13, 23), windowEndMs: phx(2026, 10, 14, 5), applyAttemptedAtMs: phx(2026, 10, 13, 23),
    attemptBaselinePct: 16, appliedAtMs: phx(2026, 10, 13, 23), priorReservePct: 16, applyVerifiedAtMs: phx(2026, 10, 13, 23, 2),
    forceChargeCeilingPct: 80, forceChargeRides: true,
  };
  const raw = JSON.parse(JSON.stringify(old));
  const c = coerceCycle(raw);
  assert.deepEqual(c.pendingLegs, []);
  assert.equal(c.trailing, null);
  assert.deepEqual(c.active, { ...coerceActuationState(raw), ...LEGACY_LEG_FIELDS }, 'the per-night record exactly, named the overnight cost leg');
  // Every v1.188 field is the value written; the fields added since read null (never fabricated).
  for (const k of Object.keys(old) as Array<keyof NightActuationStateV1188>) assert.deepEqual(c.active[k], old[k], k);
  assert.equal(c.active.nextOnPeakStartMs, null);
  assert.equal(c.active.foreignSettledAtMs, null);
  // An older record that predates the stamps added since (the force-charge, the on-peak and the
  // foreign fields): the same one-leg cycle, those fields at their idle values.
  const v150 = {
    day: '2026-08-29', announcedAtMs: 1, targetPct: 50, buyKwh: 36, windowStartMs: 2, windowEndMs: 3, cancelled: false,
    applyAttemptedAtMs: 2, attemptBaselinePct: 16, appliedAtMs: 2, priorReservePct: 16, revertedAtMs: null, revertAttempts: 0,
    revertEscalated: false, lastError: null,
  };
  assert.deepEqual(coerceCycle(v150), { active: { ...coerceActuationState(v150), ...LEGACY_LEG_FIELDS }, pendingLegs: [], trailing: null });
  assert.equal(coerceCycle(v150).active.priorReservePct, 16, 'the value a restore returns, kept');
  // An idle or unreadable file is an idle cycle.
  assert.deepEqual(coerceCycle(null), emptyCycle());
  assert.deepEqual(coerceCycle('garbage'), emptyCycle());
  assert.deepEqual(coerceCycle({ day: 'not-a-date', pendingLegs: [{ day: '2026-11-15' }] }).pendingLegs, [], 'a pending leg needs the active leg\'s plan date');
});

test('★★★ the file round-trips the whole cycle: the active leg at the top level, then pendingLegs and trailing', () => {
  const prev: ChargeCycleState = { ...emptyCycle(), active: forceChargeOffOpen(reverted(applied(asChargeLeg({
    ...emptyActuationState(), day: '2026-11-14', targetPct: 50, windowStartMs: phx(2026, 11, 14, 10), windowEndMs: phx(2026, 11, 14, 15),
  }, { windowKind: 'super_off_peak' })))) };
  const c = twoLeg(prev);
  assert.ok(c.trailing && c.pendingLegs.length === 1, 'two legs and a trailing one');
  const file = serializeCycle(c);
  assert.equal(file.cycleVersion, CYCLE_FILE_VERSION);
  // The top level IS the active leg.
  for (const [k, v] of Object.entries(c.active)) assert.deepEqual(file[k], v, k);
  assert.deepEqual(coerceCycle(JSON.parse(JSON.stringify(file))), c);
});

test('★★★ ROLLBACK: the v1.188.0 code reads the cycle file as the active leg, field for field — it still reverts and switches it off', () => {
  // A backup leg applied at 00:00, the cost leg pending, the prior cost leg trailing.
  const prev: ChargeCycleState = { ...emptyCycle(), active: forceChargeOffOpen(reverted(applied(asChargeLeg({
    ...emptyActuationState(), day: '2026-11-14', targetPct: 50, windowStartMs: phx(2026, 11, 14, 10), windowEndMs: phx(2026, 11, 14, 15),
  }, { windowKind: 'super_off_peak' })))) };
  const live = twoLeg(prev);
  const c: ChargeCycleState = { ...live, active: applied(live.active) };
  const file = JSON.parse(JSON.stringify(serializeCycle(c)));
  const asRead = coerceActuationStateV1188(file);
  assert.deepEqual(asRead, coerceActuationStateV1188(JSON.parse(JSON.stringify(c.active))), 'exactly the active leg as v1.188 reads a record');
  assert.equal(asRead.appliedAtMs, c.active.appliedAtMs);
  assert.equal(asRead.priorReservePct, 16, 'the value it restores');
  assert.equal(asRead.revertedAtMs, null, 'still to be reverted — by the rolled-back code');
  // What a rollback drops: the pending leg (it has written nothing — dropping it can only cancel a
  // write) and the trailing leg (only an OFF already sent, waiting to be read back).
  for (const p of c.pendingLegs) {
    assert.equal(p.applyAttemptedAtMs, null);
    assert.equal(p.appliedAtMs, null);
    assert.equal(p.forceChargeOnAtMs, null);
  }
  assert.ok(c.trailing!.forceChargeOffAtMs != null, 'the trailing OFF was already sent');
  // …and the file the rolled-back code writes back reads here as a one-leg cycle of that record.
  const back = coerceCycle(JSON.parse(JSON.stringify(asRead)));
  assert.deepEqual(back.pendingLegs, []);
  assert.equal(back.trailing, null);
  for (const k of Object.keys(asRead) as Array<keyof NightActuationStateV1188>) assert.deepEqual(back.active[k], asRead[k], k);
  assert.equal(back.active.leg, 'cost', 'the name is lost with the rollback: the legacy cost leg');
});

test('★★ coerce fails closed: a leg name it does not know never force-charges; pending legs that do not belong are dropped', () => {
  const base = { ...emptyActuationState(), day: DAY, targetPct: 50, windowStartMs: BACKUP.startMs, windowEndMs: BACKUP.endMs };
  assert.equal(coerceLegState({ ...base }).leg, 'cost', 'no name: the legacy cost leg');
  assert.equal(coerceLegState({ ...base, leg: 'backup' }).leg, 'backup');
  assert.equal(coerceLegState({ ...base, leg: 'cost' }).leg, 'cost');
  assert.equal(coerceLegState({ ...base, leg: 'tomorrow' }).leg, 'backup', 'unknown: the backup, which never force-charges');
  assert.equal(coerceLegState({ ...base, windowKind: 'super_off_peak' }).windowKind, 'super_off_peak');
  assert.equal(coerceLegState({ ...base, windowKind: 'x' }).windowKind, 'overnight');
  assert.equal(coerceLegState({ ...base, announcedLevelPct: 'ninety' }).announcedLevelPct, null);
  const pend = { ...base, leg: 'cost', windowKind: 'super_off_peak', windowStartMs: COST.startMs, windowEndMs: COST.endMs };
  const c = coerceCycle({
    ...base, leg: 'backup',
    pendingLegs: [pend, { ...pend, day: '2026-11-14' }, { ...pend, day: null }, 'x', pend, pend, pend],
    trailing: { day: null },
  });
  assert.equal(c.pendingLegs.length, MAX_PENDING_LEGS, 'another day, an idle one and garbage dropped; capped');
  assert.ok(c.pendingLegs.every((p) => p.day === DAY));
  assert.equal(c.trailing, null, 'an idle trailing leg is none');
  assert.deepEqual(coerceCycle({ ...base, pendingLegs: 'x' }).pendingLegs, []);
  // A pending leg's write stamps are never dropped by the coerce (were one ever there, it is kept
  // and promoted behind the active leg, where the actuator would revert it).
  assert.equal(coerceCycle({ ...base, pendingLegs: [{ ...pend, appliedAtMs: 5, priorReservePct: 16 }] }).pendingLegs[0].appliedAtMs, 5);
});

/* ══ arming ═══════════════════════════════════════════════════════════════════════════════════ */

/** The prior records the arming battery runs against. */
function priorStates(): Array<[string, NightActuationState]> {
  const w = { windowStartMs: phx(2026, 10, 12, 23), windowEndMs: phx(2026, 10, 13, 5) };
  const armedPrior = { ...emptyActuationState(), day: '2026-10-12', announcedAtMs: phx(2026, 10, 12, 21, 30), targetPct: 50, buyKwh: 30, ...w };
  const app = applied(armedPrior);
  return [
    ['idle', emptyActuationState()],
    ['armed, another evening (Saturday for Monday)', armedPrior],
    ['armed, today', { ...armedPrior, day: '2026-10-13' }],
    ['applied, unrestored', app],
    ['applied, cancelled, unrestored', { ...app, cancelled: true }],
    ['restored, read back', reverted(app)],
    ['restored, not read back', reverted(app, w.windowEndMs, false)],
    ['someone else\'s reserve', { ...app, foreignSettledAtMs: w.windowStartMs + 2 * H, foreignReservePct: 30 }],
    ['force-charge OFF unverified', forceChargeOffOpen(reverted(app))],
    ['force-charge OFF verified', { ...forceChargeOffOpen(reverted(app)), forceChargeOffVerifiedAtMs: w.windowEndMs + MIN }],
    ['force-charge ON, no OFF yet', { ...forceChargeOffOpen(reverted(app)), forceChargeOffAtMs: null }],
    ['attempted, unconfirmed', { ...armedPrior, applyAttemptedAtMs: w.windowStartMs, attemptBaselinePct: 16 }],
    ['ceiling original unrestored', { ...reverted(app), forceChargeCeilingPriorPct: 100, forceChargeCeilingAttemptedAtMs: w.windowStartMs }],
    ['ceiling original restored', { ...reverted(app), forceChargeCeilingPriorPct: 100, forceChargeCeilingRestoredAtMs: w.windowEndMs + MIN }],
  ];
}

test('★★★ ONE LEG: armCycle arms exactly what armFromPlan arms, and refuses with armRefusalReason\'s words — against every prior record', () => {
  const now = phx(2026, 10, 13, 21, 30);
  const tonight = { startMs: phx(2026, 10, 13, 23), endMs: phx(2026, 10, 14, 5) };
  const plans: Array<[string, ArmablePlan]> = [
    ['charge', plan(tonight, { setpointSocPct: 94, costCeilingSocPct: 80, buyKwh: 63.9 })],
    ['charge, reserve-only', plan(tonight, { costCeilingSocPct: null })],
    ['charge, ceiling at the reserve', plan(tonight, { costCeilingSocPct: 48 })],
    ['hold', plan(tonight, { chargeTonight: false })],
    ['incomplete basis', plan(tonight, { basisComplete: false })],
    ['no window', plan(null)],
    ['no buy', plan(tonight, { buyKwh: 0 })],
    ['window opened long ago', plan({ startMs: now - 2 * H, endMs: now + 3 * H })],
  ];
  let checked = 0;
  for (const [pn, prior] of priorStates()) {
    for (const [plnName, p] of plans) {
      for (const live of [16, null, 50]) {
        for (const fc of [true, false, undefined]) {
          for (const peak of [phx(2026, 10, 14, 16), null, undefined]) {
            const want = armFromPlan(prior, '2026-10-13', p, now, live, fc, peak);
            const r = armCycle({ ...emptyCycle(), active: asChargeLeg(prior) }, '2026-10-13', [{
              role: 'cost', kind: 'overnight', plan: p, forceChargeEnabled: fc, nextOnPeakStartMs: peak,
              announcedLevelPct: 80, announcedExpectedKwh: 34.9,
            }], now, live);
            const why = `${pn} × ${plnName} × live ${live} × fc ${fc} × peak ${peak}`;
            if (want == null) {
              assert.equal(r.cycle, null, why);
              assert.deepEqual(r.refused, [{ role: 'cost', reason: armRefusalReason(prior, p, now, live) }], why);
            } else {
              assert.deepEqual(r.refused, [], why);
              assert.deepEqual(r.cycle, { active: { ...want, leg: 'cost', windowKind: 'overnight', announcedLevelPct: 80, announcedExpectedKwh: 34.9, refreshedAtMs: null, missedApplyPushedAtMs: null }, pendingLegs: [], trailing: null }, why);
              assert.equal(r.trailingFrom, null, why);
            }
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 14 * 8 * 27);
  // armRefusalReason leads with the open item, which is armOpenItem — one definition.
  for (const [, prior] of priorStates()) {
    const open = armOpenItem(prior, 16);
    if (open != null) assert.equal(armRefusalReason(prior, plan({ startMs: now + H, endMs: now + 7 * H }), now, 16), open);
  }
});

test('★★★ TWO LEGS: the backup leg is reserve-only, the cost leg waits behind it, and the first armed leg owns the ceiling original', () => {
  const r = armCycle(emptyCycle(), DAY, candidates(), SUN_2130, 16);
  assert.deepEqual(r.refused, []);
  const c = r.cycle!;
  assert.equal(c.active.leg, 'backup');
  assert.equal(c.active.windowKind, 'overnight');
  assert.equal(c.active.forceChargeCeilingPct, null, 'the backup never force-charges');
  assert.equal(c.active.forceChargeRides, false);
  assert.equal(c.active.windowStartMs, BACKUP.startMs);
  assert.deepEqual(c.pendingLegs.map((p) => [p.leg, p.windowKind, p.windowStartMs, p.forceChargeCeilingPct, p.forceChargeRides]),
    [['cost', 'super_off_peak', COST.startMs, 90, true]]);
  assert.equal(c.pendingLegs[0].nextOnPeakStartMs, PEAK, 'each leg carries its on-peak stamp');
  assert.equal(c.pendingLegs[0].announcedLevelPct, 90);
  assert.equal(c.trailing, null);
  // The backup's stamp says it never rides, whatever the option — supplied or not.
  for (const fc of [true, false, undefined]) {
    const cands = candidates();
    cands[0] = { ...cands[0], forceChargeEnabled: fc };
    assert.equal(armCycle(emptyCycle(), DAY, cands, SUN_2130, 16).cycle!.active.forceChargeRides, false, `option ${fc}`);
  }
  // An unrestored ceiling original from the prior night travels with the FIRST leg only.
  const prior = asChargeLeg({ ...reverted(applied({ ...emptyActuationState(), day: '2026-11-14', targetPct: 50, windowStartMs: phx(2026, 11, 14, 23), windowEndMs: phx(2026, 11, 15, 5) })), forceChargeCeilingPriorPct: 100 });
  const withCeiling = armCycle({ ...emptyCycle(), active: prior }, DAY, candidates(), SUN_2130, 16).cycle!;
  assert.equal(withCeiling.active.forceChargeCeilingPriorPct, 100);
  assert.equal(withCeiling.pendingLegs[0].forceChargeCeilingPriorPct, null, 'one leg owns the restore');
  // A backup that does not arm (a hold) leaves the cost leg first — and it carries the original.
  const costOnly = armCycle({ ...emptyCycle(), active: prior }, DAY, candidates({ backup: { chargeTonight: false } }), SUN_2130, 16);
  assert.deepEqual(costOnly.refused, [{ role: 'backup', reason: 'the plan does not call for a charge' }]);
  assert.equal(costOnly.cycle!.active.leg, 'cost');
  assert.equal(costOnly.cycle!.active.forceChargeCeilingPriorPct, 100);
  assert.deepEqual(costOnly.cycle!.pendingLegs, []);
});

test('★★★ TRAILING: a backup arms over a prior leg whose only open item is its force-charge OFF; anything else refuses every leg', () => {
  const priorDay = '2026-11-14';
  const prior = forceChargeOffOpen(reverted(applied(asChargeLeg({
    ...emptyActuationState(), day: priorDay, targetPct: 50, windowStartMs: phx(2026, 11, 14, 10), windowEndMs: phx(2026, 11, 14, 15),
  }, { windowKind: 'super_off_peak' }))));
  assert.equal(onlyForceChargeOffOpen(prior, 16), true);
  const r = armCycle({ ...emptyCycle(), active: prior }, DAY, candidates(), SUN_2130, 16);
  assert.deepEqual(r.refused, []);
  assert.equal(r.trailingFrom, prior);
  assert.equal(r.cycle!.trailing, prior, 'the prior leg keeps its OFF verification, re-sends and ceiling restore');
  assert.equal(r.cycle!.active.leg, 'backup');
  assert.equal(r.cycle!.active.forceChargeCeilingPriorPct, null, 'the ceiling original stays with the trailing leg');
  // The same prior refuses a cycle whose first leg is a cost leg — today's rule, with today's words.
  const one = armCycle({ ...emptyCycle(), active: prior }, DAY, [candidates()[1]], SUN_2130, 16);
  assert.equal(one.cycle, null);
  assert.deepEqual(one.refused, [{ role: 'cost', reason: `the ${priorDay} force-charge was switched ON and its OFF has not verified` }]);
  // A backup that does not arm leaves the open item in place: the cost leg is refused on it.
  const hold = armCycle({ ...emptyCycle(), active: prior }, DAY, candidates({ backup: { chargeTonight: false } }), SUN_2130, 16);
  assert.equal(hold.cycle, null);
  assert.deepEqual(hold.refused.map((x) => x.role), ['backup', 'cost']);
  assert.match(hold.refused[1].reason, /force-charge was switched ON and its OFF has not verified/);
  // Any other open item refuses every leg, with the same words.
  for (const other of [
    { ...prior, revertedAtMs: null, revertVerifiedAtMs: null }, // applied, unrestored
    { ...prior, appliedAtMs: null, revertedAtMs: null, revertVerifiedAtMs: null, priorReservePct: null }, // attempted, unconfirmed
  ]) {
    assert.equal(onlyForceChargeOffOpen(other, 30), false);
    const x = armCycle({ ...emptyCycle(), active: other }, DAY, candidates(), SUN_2130, 30);
    assert.equal(x.cycle, null);
    assert.equal(new Set(x.refused.map((y) => y.reason)).size, 1, 'one reason');
    assert.equal(x.refused[0].reason, armOpenItem(other, 30));
  }
  // An open trailing leg refuses the next cycle (one trailing leg at a time).
  const withTrailing = r.cycle!;
  const next = armCycle({ ...withTrailing, active: reverted(applied(withTrailing.active)) }, '2026-11-16', candidates(), SUN_2130 + 24 * H, 16);
  assert.equal(next.cycle, null);
  assert.ok(next.refused.every((x) => x.reason === `the ${priorDay} force-charge was switched ON and its OFF has not verified`));
});

test('★★ supersede compares legs: the active leg by the v1.79.0 rule, a pending leg only before its window passes', () => {
  const sat = { ...twoLeg().active, day: '2026-11-14', leg: 'cost' as const, windowKind: 'overnight' as const };
  const next = twoLeg();
  const out = supersededLegs({ ...emptyCycle(), active: sat }, [next.active, ...next.pendingLegs], DAY, SUN_2130);
  assert.deepEqual(out.map((o) => [o.leg.day, o.sharedWindow]), [['2026-11-14', true]], 'Saturday\'s arm for the shared Monday window');
  const pend = { ...next.pendingLegs[0], day: '2026-11-14' };
  const late = supersededLegs({ active: { ...sat, appliedAtMs: 1 }, pendingLegs: [pend], trailing: null }, [], DAY, COST.startMs + APPLY_LATE_MS + 1);
  assert.deepEqual(late, [], 'a pending leg past its apply window was missed, not superseded; an applied active leg is never');
  assert.equal(supersededLegs({ active: sat, pendingLegs: [pend], trailing: null }, [], DAY, SUN_2130).length, 2);
});

/* ══ legResolved and promotion ════════════════════════════════════════════════════════════════ */

test('★★★ legResolved: finished, nothing of ours left on the device, and the restore and OFF read back', () => {
  const b = twoLeg().active;
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  assert.equal(legResolved(b, SUN_2130, 16), false, 'armed, before its window');
  assert.equal(legResolved(applied(b), at(1), 50), false, 'applied');
  assert.equal(legResolved(reverted(applied(b), at(5), false), at(5, 2), 50), false, 'restored, not read back');
  // Not read back, and the panel reads a value of no one's yet (a foreign sighting not settled):
  // nothing of ours provably holds it (armOpenItem), but the restore has not read back either.
  const pending = { ...reverted(applied(b), at(5), false), foreignReservePct: 30, foreignSeenAtMs: at(5, 1) };
  assert.equal(armOpenItem(pending, 30), null);
  assert.equal(legResolved(pending, at(5, 2), 30), false, 'restored, not read back, the reading not settled');
  assert.equal(legResolved(reverted(applied(b)), at(5, 2), 16), true, 'restored and read back');
  assert.equal(legResolved({ ...b, cancelled: true }, SUN_2130 + H, 16), true, 'cancelled before any write');
  assert.equal(legResolved(b, BACKUP.startMs + APPLY_LATE_MS, 16), false, 'the apply window still open');
  assert.equal(legResolved(b, BACKUP.startMs + APPLY_LATE_MS + 1, 16), true, 'missed: past its apply window with no write');
  assert.equal(legResolved({ ...applied(b), foreignSettledAtMs: at(2), foreignReservePct: 30 }, at(2, 1), 30), true, 'someone else\'s reserve');
  // ★ An unconfirmed write blocks promotion, and the active leg's ADOPT can still revert it.
  const attempted = { ...b, applyAttemptedAtMs: BACKUP.startMs, attemptBaselinePct: 16 };
  assert.equal(legResolved(attempted, at(2), 50), false, 'reads the target: it landed');
  assert.equal(legResolved(attempted, at(2), null), false, 'no reading: unknown');
  assert.equal(legResolved(attempted, at(2), 16), true, 'reads the baseline: it never landed');
  assert.deepEqual(decideActuation(attempted, at(2), {
    mode: 'supervised', writeReady: false, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true,
  }), { kind: 'adopt', priorPct: 16 });
  // A force-charge OFF that has not read back.
  const fc = forceChargeOffOpen(reverted(applied({ ...b })));
  assert.equal(legResolved(fc, at(6), 16), false);
  assert.equal(legResolved({ ...fc, forceChargeOffVerifiedAtMs: at(5, 7) }, at(6), 16), true);
  // The ceiling original is not a condition: it travels on.
  assert.equal(legResolved({ ...reverted(applied(b)), forceChargeCeilingPriorPct: 100 }, at(6), 16), true);
  assert.equal(legFinished(emptyActuationState(), 0), true);
  assert.equal(legResolved(emptyActuationState(), 0, null), true);
});

test('★★★ promotion: a resolved backup hands over to the cost leg; a trailing leg holds it; a one-leg cycle never promotes', () => {
  const c = twoLeg();
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  assert.equal(promoteCycle(c, SUN_2130 + MIN, 16), null, 'armed: nothing to do');
  const night: ChargeCycleState = { ...c, active: applied(c.active) };
  assert.equal(promoteCycle(night, at(3), 50), null);
  assert.equal(promoteCycle({ ...c, active: reverted(applied(c.active), at(5), false) }, at(5, 2), 50), null, 'the restore has not read back');
  const done: ChargeCycleState = { ...c, active: reverted(applied(c.active), at(5)) };
  const step = promoteCycle(done, at(5, 2), 16)!;
  assert.ok(step.promoted);
  assert.equal(step.promoted.from, done.active);
  assert.equal(step.cycle.active, c.pendingLegs[0], 'the cost leg is active, untouched');
  assert.deepEqual(step.cycle.pendingLegs, []);
  assert.equal(step.trailingDone, null);
  // ★ An UNCONFIRMED backup write (attempted at 00:00, no answer) blocks promotion while the panel
  // reads anything but the attempt-time baseline — the backup's ADOPT can still revert it.
  const attempted: ChargeCycleState = { ...c, active: { ...c.active, applyAttemptedAtMs: BACKUP.startMs, attemptBaselinePct: 16 } };
  for (const live of [50, null, 30]) assert.equal(promoteCycle(attempted, at(6), live), null, `reads ${live}`);
  assert.equal(promoteCycle(attempted, at(6), 16)!.cycle.active.leg, 'cost', 'reads the baseline: it never landed');
  // A backup still unresolved at 10:30 leaves the cost leg pending: it is MISSED (missedApplyDue).
  const stuck: ChargeCycleState = { ...c, active: reverted(applied(c.active), at(5), false) };
  assert.equal(promoteCycle(stuck, COST.startMs + APPLY_LATE_MS + 1, 50), null);
  assert.equal(missedApplyDue(stuck.pendingLegs[0], COST.startMs + APPLY_LATE_MS + 1), true);
  // A trailing leg holds the cost leg until it resolves; its resolution and the promotion can share a step.
  const prior = forceChargeOffOpen(reverted(applied(asChargeLeg({
    ...emptyActuationState(), day: '2026-11-14', targetPct: 50, windowStartMs: phx(2026, 11, 14, 10), windowEndMs: phx(2026, 11, 14, 15),
  }, { windowKind: 'super_off_peak' }))));
  const tc = twoLeg({ ...emptyCycle(), active: prior });
  const tDone: ChargeCycleState = { ...tc, active: reverted(applied(tc.active), at(5)) };
  assert.equal(promoteCycle(tDone, at(5, 2), 16), null, 'the trailing OFF is still unverified');
  assert.equal(trailingResolved(tDone.trailing!), false);
  const offRead = { ...tDone.trailing!, forceChargeOffVerifiedAtMs: at(5, 1) };
  // Its ceiling restore still has attempts: not yet resolved.
  assert.equal(trailingResolved(offRead), false);
  const spent = { ...offRead, forceChargeCeilingRestoreAttempts: FORCE_CHARGE_CEILING_RESTORE_ATTEMPTS };
  const both = promoteCycle({ ...tDone, trailing: spent }, at(5, 2), 16)!;
  assert.equal(both.trailingDone, spent);
  assert.ok(both.promoted);
  assert.equal(both.cycle.trailing, null);
  assert.equal(both.cycle.active.leg, 'cost');
  assert.equal(both.cycle.active.forceChargeCeilingPriorPct, 100, 'the unrestored original travelled: trailing → backup → cost');
  assert.equal(both.cycle.active.forceChargeCeilingRestoreAttempts, 0, 'with a fresh budget');
  const restored = { ...offRead, forceChargeCeilingRestoredAtMs: at(5, 1) };
  assert.equal(promoteCycle({ ...tDone, trailing: restored }, at(5, 2), 16)!.cycle.active.forceChargeCeilingPriorPct, null);
  // carryCeilingPrior never overwrites an original the next leg already has.
  assert.equal(carryCeilingPrior({ ...emptyActuationState(), forceChargeCeilingPriorPct: 100 }, { ...emptyActuationState(), forceChargeCeilingPriorPct: 95 }).forceChargeCeilingPriorPct, 95);
  // ★ ONE LEG: nothing pending or trailing — the step never changes anything, in any state.
  for (const [, s] of priorStates()) {
    for (const t of [SUN_2130, at(5, 2), at(12)]) assert.equal(promoteCycle({ ...emptyCycle(), active: asChargeLeg(s) }, t, 16), null);
  }
});

test('★★★ a missed leg is promoted away only once its missed-apply push is stamped — never unannounced', () => {
  // The backup's apply window passes at 00:30 with no write (say the panel was silent): it is
  // resolved (finished, nothing of ours on the device) at the very instant its push falls due.
  const c = twoLeg();
  const late = BACKUP.startMs + APPLY_LATE_MS + 1;
  assert.equal(legResolved(c.active, late, 16), true);
  assert.equal(missedApplyDue(c.active, late), true);
  assert.equal(promoteCycle(c, late, 16), null, 'held: the push step has not stamped it yet');
  assert.equal(promoteCycle(c, late + 10 * MIN, 16), null, 'held for as long as the push is due');
  const pushed: ChargeCycleState = { ...c, active: { ...c.active, missedApplyPushedAtMs: late } };
  const step = promoteCycle(pushed, late + MIN, 16)!;
  assert.equal(step.promoted!.from.missedApplyPushedAtMs, late, 'the leg that leaves was announced');
  assert.equal(step.cycle.active.leg, 'cost');
  // A cancelled leg owes no push, and goes at once.
  assert.equal(promoteCycle({ ...c, active: { ...c.active, cancelled: true } }, late, 16)!.cycle.active.leg, 'cost');
  // ★ ONE LEG: an overnight cost leg never owes the push, and nothing is pending — never held, never promoted.
  for (const [, s] of priorStates()) assert.equal(missedApplyDue(asChargeLeg(s), late), false);
});

test('★★★ blind OFF re-sends stop at the next cost leg\'s open; with one leg, at the plan\'s window exactly as R1 bounded them', () => {
  /** The bound R1 (v1.189.0, before the cycle record) passed, verbatim. */
  const r1 = (s: NightActuationState, planStart: number | null | undefined) =>
    planStart != null && s.windowEndMs != null && planStart >= s.windowEndMs ? planStart : null;
  const night = asChargeLeg({ ...emptyActuationState(), day: '2026-10-13', targetPct: 50, windowStartMs: phx(2026, 10, 13, 23), windowEndMs: phx(2026, 10, 14, 5) });
  for (const planStart of [null, undefined, phx(2026, 10, 14, 23), phx(2026, 10, 13, 23), phx(2026, 10, 14, 5), phx(2026, 10, 14, 4, 59)]) {
    assert.equal(nextForceChargeOpenMs(night, [], planStart), r1(night, planStart), `plan window ${planStart}`);
  }
  assert.equal(nextForceChargeOpenMs({ windowEndMs: null }, [], phx(2026, 10, 14, 23)), null, 'no window: no bound');
  // Two legs: a trailing cost leg's re-sends stop at the pending cost leg's 10:00 open, never at the
  // backup's 00:00 (a backup never force-charges) — and ahead of a later plan.
  const c = twoLeg();
  const prior = { windowEndMs: phx(2026, 11, 15, 15) };
  assert.equal(nextForceChargeOpenMs(prior, [c.active, ...c.pendingLegs], phx(2026, 11, 16, 23)), COST.startMs);
  assert.equal(nextForceChargeOpenMs(prior, [c.active], phx(2026, 11, 16, 23)), phx(2026, 11, 16, 23), 'no cost leg behind: the plan');
  assert.equal(nextForceChargeOpenMs({ windowEndMs: COST.endMs }, [c.pendingLegs[0]], null), null, 'a leg opening before the close is not next');
});

test('★★ the persisted arm takes the trailing leg as the ticks left it during the announcement, and nothing else', () => {
  const prior = forceChargeOffOpen(reverted(applied(asChargeLeg({
    ...emptyActuationState(), day: '2026-11-14', targetPct: 50, windowStartMs: phx(2026, 11, 14, 10), windowEndMs: phx(2026, 11, 14, 15),
  }, { windowKind: 'super_off_peak' }))));
  const armed = twoLeg({ ...emptyCycle(), active: prior });
  // While the announcement was awaited, the tick read the OFF back on the record in place.
  const live = { ...prior, forceChargeOffVerifiedAtMs: SUN_2130 + MIN };
  const out = withLiveTrailing(armed, live);
  assert.equal(out.trailing, live);
  assert.equal(out.active, armed.active);
  assert.equal(out.pendingLegs, armed.pendingLegs);
  // Another leg in place (another day or window) is not the trailing leg: the arm-time copy stands.
  assert.equal(withLiveTrailing(armed, { ...live, day: '2026-11-13' }), armed);
  assert.equal(withLiveTrailing(armed, { ...live, windowStartMs: phx(2026, 11, 14, 23) }), armed);
  assert.equal(withLiveTrailing(armed, emptyLegState()), armed);
  // ★ ONE LEG: nothing trails — the cycle is persisted exactly as armed.
  const one = armCycle(emptyCycle(), '2026-10-13', [{ role: 'cost', kind: 'overnight', plan: plan({ startMs: phx(2026, 10, 13, 23), endMs: phx(2026, 10, 14, 5) }) }], phx(2026, 10, 13, 21, 30), 16).cycle!;
  assert.equal(withLiveTrailing(one, live), one);
});

/* ══ the owner's cancel, by leg ═══════════════════════════════════════════════════════════════ */

test('★★★ cancel at 22:00, 05:02 and 08:00: no leg named stops the daytime charge; the backup has its own action', () => {
  const c = twoLeg();
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  // 22:00 Sunday — both legs armed, nothing written.
  const d = cancelLeg(c, null);
  assert.ok(d.ok);
  assert.equal(d.where, 'pending');
  assert.equal(d.leg.leg, 'cost');
  assert.equal(d.cycle.pendingLegs[0].cancelled, true);
  assert.equal(d.cycle.active.cancelled, false, 'tonight\'s backup stands');
  const bk = cancelLeg(c, 'backup');
  assert.ok(bk.ok);
  assert.equal(bk.where, 'active');
  assert.equal(bk.cycle.active.cancelled, true);
  assert.equal(bk.cycle.pendingLegs[0].cancelled, false, 'the daytime charge stands');
  // A cancelled backup is resolved: the cost leg takes over at once.
  assert.equal(promoteCycle(bk.cycle, SUN_2130 + 31 * MIN, 16)!.cycle.active.leg, 'cost');
  // 05:02 — the backup restored at 05:00, not yet read back: the cost leg is still cancellable.
  const morning: ChargeCycleState = { ...c, active: reverted(applied(c.active), at(5), false) };
  const m = cancelLeg(morning, null);
  assert.ok(m.ok, 'the pending leg is looked at before any 409');
  assert.equal(m.leg.leg, 'cost');
  assert.deepEqual(cancelLeg(morning, 'backup'), { ok: false, error: 'tonight’s write already completed and reverted' });
  // 08:00 — the backup resolved, the cost leg active.
  const day = promoteCycle({ ...c, active: reverted(applied(c.active), at(5)) }, at(5, 2), 16)!.cycle;
  const e = cancelLeg(day, null);
  assert.ok(e.ok);
  assert.equal(e.where, 'active');
  assert.equal(e.cycle.active.cancelled, true);
  assert.deepEqual(cancelLeg(day, 'backup'), { ok: false, error: 'no outage backup is armed' });
  assert.ok(cancelLeg(day, 'cost').ok);
  // After the write applied: cancelling it is a revert, on the next tick (decideActuation).
  const live = { ...day, active: applied(day.active, COST.startMs) };
  const x = cancelLeg(live, null);
  assert.ok(x.ok);
  assert.deepEqual(decideActuation(x.cycle.active, COST.startMs + H, {
    mode: 'supervised', writeReady: false, currentReservePct: 50, socCoherent: true, vitalsRed: false, gridPresent: true,
  }), { kind: 'revert', restorePct: 16 });
});

test('★★★ ONE LEG: the cancel answers exactly as the route always has, with or without a leg named', () => {
  const tonight = asChargeLeg({ ...emptyActuationState(), day: '2026-10-13', targetPct: 50, windowStartMs: phx(2026, 10, 13, 23), windowEndMs: phx(2026, 10, 14, 5) });
  const one = (s: ChargeLegState): ChargeCycleState => ({ ...emptyCycle(), active: s });
  for (const req of [null, 'cost'] as const) {
    assert.deepEqual(cancelLeg(emptyCycle(), req), { ok: false, error: 'no supervised write is armed' });
    assert.deepEqual(cancelLeg(one(reverted(applied(tonight))), req), { ok: false, error: 'tonight’s write already completed and reverted' });
    assert.deepEqual(cancelLeg(one({ ...applied(tonight), foreignSettledAtMs: 1, foreignReservePct: 30 }), req),
      { ok: false, error: 'the reserve was set to 30% outside the add-on; nothing of tonight’s write is left to cancel' });
    for (const s of [tonight, applied(tonight), { ...tonight, cancelled: true }]) {
      const r = cancelLeg(one(s), req);
      assert.ok(r.ok);
      assert.deepEqual(r.cycle, one({ ...s, cancelled: true }), 'the route\'s { ...s, cancelled: true }, nothing else');
    }
  }
  assert.deepEqual(cancelLeg(one(tonight), 'backup'), { ok: false, error: 'no outage backup is armed' });
  assert.equal(parseCancelLeg(undefined), null);
  assert.equal(parseCancelLeg(null), null);
  assert.equal(parseCancelLeg({}), null);
  assert.equal(parseCancelLeg({ leg: null }), null);
  assert.equal(parseCancelLeg({ leg: 'cost' }), 'cost');
  assert.equal(parseCancelLeg({ leg: 'backup' }), 'backup');
  assert.equal(parseCancelLeg({ leg: 'all' }), undefined, 'the route answers 400');
  assert.equal(parseCancelLeg({ leg: 1 }), undefined);
});

/* ══ status ═══════════════════════════════════════════════════════════════════════════════════ */

test('★★ status legs[]: trailing, active, pending, each with its state', () => {
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  const c = twoLeg();
  assert.deepEqual(cycleLegsStatus(c, SUN_2130 + MIN).map((l) => [l.position, l.leg, l.windowKind, l.state, l.cancelDeadlineMs]),
    [['active', 'backup', 'overnight', 'armed', BACKUP.startMs], ['pending', 'cost', 'super_off_peak', 'armed', COST.startMs]]);
  assert.equal(cycleLegsStatus(c, SUN_2130)[1].announcedExpectedKwh, 34);
  assert.deepEqual(cycleLegsStatus(emptyCycle(), 0), []);
  assert.equal(cycleLegsStatus({ ...emptyCycle(), active: asChargeLeg({ ...emptyActuationState(), day: '2026-10-13', targetPct: 50 }) }, 0).length, 1);
  const s = (x: NightActuationState, t = at(3)) => legStatusState(x, t);
  assert.equal(s(emptyActuationState()), 'idle');
  assert.equal(s(c.active, SUN_2130), 'armed');
  assert.equal(s({ ...c.active, cancelled: true }, SUN_2130), 'cancelled');
  assert.equal(s(c.active, BACKUP.startMs + APPLY_LATE_MS + 1), 'missed');
  assert.equal(s(applied(c.active)), 'applied');
  assert.equal(s({ ...applied(c.active), cancelled: true }), 'restoring');
  assert.equal(s(reverted(applied(c.active), at(5), false)), 'restoring');
  assert.equal(s(reverted(applied(c.active), at(5))), 'completed');
  assert.equal(s({ ...applied(c.active), foreignSettledAtMs: at(2) }), 'foreign');
  assert.equal(s(forceChargeOffOpen(reverted(applied({ ...c.pendingLegs[0] })))), 'forceChargeOff');
});

/* ══ settings-drift attribution, per leg (plan §4.6) ═════════════════════════════════════════ */

/** The rule settings-drift applied in v1.188.0 (index.ts driftActuatorContext at 111247f), verbatim:
 *  it has no foreign-settled term — R1 added that night shape, and its exclusion. */
function v1188NightActive(act: NightActuationState, nowMs: number): boolean {
  return act.day != null &&
    ((act.appliedAtMs != null && act.revertedAtMs == null) ||
     (act.announcedAtMs != null && act.appliedAtMs == null && act.cancelled !== true) ||
     (act.revertedAtMs != null && nowMs - act.revertedAtMs < 15 * 60_000));
}

test('★★★ ONE LEG: the overnight leg is attributed exactly as v1.188 attributed it, through a night of every shape — but a foreign-settled night, which R1 makes the owner\'s', () => {
  const ws = phx(2026, 10, 13, 23);
  const we = phx(2026, 10, 14, 5);
  const armed = asChargeLeg({ ...emptyActuationState(), day: '2026-10-13', announcedAtMs: phx(2026, 10, 13, 21, 30), targetPct: 50, windowStartMs: ws, windowEndMs: we });
  const shapes: ChargeLegState[] = [
    armed, { ...armed, cancelled: true }, applied(armed), { ...applied(armed), cancelled: true },
    reverted(applied(armed)), reverted(applied(armed), we, false), { ...reverted(applied(armed)), revertLastAttemptMs: we + 10 * MIN },
    { ...applied(armed), foreignSettledAtMs: ws + 2 * H }, { ...armed, applyAttemptedAtMs: ws, attemptBaselinePct: 16 },
    emptyLegState(),
  ];
  let n = 0;
  let differs = 0;
  for (const s of shapes) {
    for (let t = phx(2026, 10, 13, 21); t <= phx(2026, 10, 14, 12); t += 5 * MIN) {
      const c: ChargeCycleState = { ...emptyCycle(), active: s };
      const head = cycleDriftLeg(c, t) != null;
      if (s.foreignSettledAtMs != null) {
        // ★ The one intended difference (R1): a reserve someone else set is theirs, so a later change
        // of it is theirs too — v1.188 (which had no foreign rule) would still have called it ours.
        if (v1188NightActive(s, t) && !head) differs++;
        assert.equal(head, s.revertedAtMs != null && t - s.revertedAtMs < DRIFT_TAIL_MS, `${new Date(t).toISOString()}: foreign-settled`);
      } else {
        assert.equal(head, v1188NightActive(s, t), `${new Date(t).toISOString()}`);
      }
      if (head) assert.equal(cycleDriftLeg(c, t), s, 'the target and restore come from the same record');
      n++;
    }
  }
  assert.ok(n > 1500);
  assert.ok(differs > 100, 'the foreign-settled night really is attributed differently from v1.188');
});

test('★★★ the mid-day leg drops the armed 21:30 → 10:00 span: only its apply window and its write to 15 min after the last restore', () => {
  const c = twoLeg();
  const cost = c.pendingLegs[0];
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  assert.equal(legDriftActive(cost, SUN_2130 + MIN), false, 'armed at 21:30');
  assert.equal(legDriftActive(cost, at(5)), false);
  assert.equal(legDriftActive(cost, COST.startMs - DRIFT_LEAD_MS - 1), false);
  assert.equal(legDriftActive(cost, COST.startMs - DRIFT_LEAD_MS), true, '09:50');
  assert.equal(legDriftActive(cost, COST.startMs + APPLY_LATE_MS), true, '10:30');
  assert.equal(legDriftActive(cost, COST.startMs + APPLY_LATE_MS + 1), false, 'no write: past its apply window');
  assert.equal(legDriftActive({ ...cost, cancelled: true }, COST.startMs + MIN), false, 'cancelled before any attempt');
  const w = applied(cost, COST.startMs);
  assert.equal(legDriftActive(w, at(13)), true, 'applied: until restored');
  assert.equal(legDriftActive({ ...w, applyAttemptedAtMs: COST.startMs, appliedAtMs: null }, at(13)), true, 'an attempt unconfirmed is ours');
  // ★ The 15:00 restore is ours for 15 minutes — from the LAST restore attempt.
  const r = reverted(w, COST.endMs);
  assert.equal(legDriftActive(r, COST.endMs + DRIFT_TAIL_MS - 1), true, '15:14:59');
  assert.equal(legDriftActive(r, COST.endMs + DRIFT_TAIL_MS), false, '15:15');
  const retried = { ...r, revertLastAttemptMs: COST.endMs + 6 * MIN };
  assert.equal(legDriftActive(retried, COST.endMs + 20 * MIN), true, 'a re-issued restore at 15:06 is ours to 15:21');
  assert.equal(legDriftActive({ ...w, foreignSettledAtMs: at(12) }, at(13)), false, 'someone else\'s reserve');
  // The cycle picks the leg whose span is open: the backup's restore tail at 05:05, the cost leg at 10:05.
  const night: ChargeCycleState = { ...c, active: reverted(applied(c.active), at(5)) };
  assert.equal(cycleDriftLeg(night, at(5, 5)), night.active);
  assert.equal(cycleDriftLeg(night, at(8)), null, 'nothing of ours between the legs');
  assert.equal(cycleDriftLeg(night, at(10, 5)), night.pendingLegs[0]);
});

test('★★★ a leg that left the cycle keeps its drift tail: the backup\'s restore and a trailing leg\'s OFF, confirmed after they left, are ours', () => {
  const at = (h: number, mi = 0) => phx(2026, 11, 16, h, mi);
  // (2) The backup's restore verifies at 05:01 and the next tick promotes the cost leg.
  const c = twoLeg();
  const night: ChargeCycleState = { ...c, active: reverted(applied(c.active), at(5)) };
  const step = promoteCycle(night, at(5, 2), 16)!;
  assert.ok(step.promoted, 'promoted');
  const left = departedAfterStep([], step, at(5, 2));
  assert.deepEqual(left.map((d) => [d.leg.leg, d.leftAtMs]), [['backup', at(5, 2)]]);
  // Settings-drift confirms the 50 → 16 a drift tick later: without the tail, nothing of ours.
  assert.equal(cycleDriftLeg(step.cycle, at(5, 3)), null, 'the leg is gone from the cycle');
  assert.equal(cycleDriftLeg(step.cycle, at(5, 3), left), night.active, 'the departed backup still owns its restore');
  assert.equal(cycleDriftLeg(step.cycle, at(5, 14), left), night.active);
  assert.equal(cycleDriftLeg(step.cycle, at(5, 2) + DRIFT_TAIL_MS, left), null, 'no longer than the drift tail');
  assert.deepEqual(recentlyDeparted(left, at(5, 2) + DRIFT_TAIL_MS), []);
  assert.deepEqual(departedAfterStep(left, null, at(5, 2) + DRIFT_TAIL_MS), [], 'pruned');
  // (1) A trailing leg whose OFF reads back leaves on that tick; its OFF is confirmed a tick later.
  const fcOff = forceChargeOffOpen(reverted(applied(asChargeLeg({ ...c.pendingLegs[0], day: '2026-11-14' }))));
  const done = { ...fcOff, forceChargeOffVerifiedAtMs: at(15, 3), forceChargeCeilingRestoredAtMs: at(15, 3) };
  const trailing: ChargeCycleState = { ...c, trailing: done };
  const tstep = promoteCycle(trailing, at(15, 3), 16)!;
  assert.equal(tstep.trailingDone, done);
  const gone = departedAfterStep([], tstep, at(15, 3));
  const fcActive = (l: NightActuationState) => l.forceChargeOffVerifiedAtMs != null && at(15, 4) - l.forceChargeOffVerifiedAtMs < 15 * MIN;
  assert.equal(forceChargeDriftLeg(tstep.cycle, [], at(15, 4), fcActive), tstep.cycle.active, 'without the tail: the active leg, which commanded nothing');
  assert.equal(forceChargeDriftLeg(tstep.cycle, gone, at(15, 4), fcActive), done, 'with it: the leg that sent the OFF');
  // The trailing leg still in the cycle, and an active leg of its own, keep their precedence.
  assert.equal(forceChargeDriftLeg(trailing, gone, at(15, 4), fcActive), done);
  const busy: ChargeCycleState = { ...tstep.cycle, active: { ...tstep.cycle.active, forceChargeOffVerifiedAtMs: at(15, 3) } };
  assert.equal(forceChargeDriftLeg(busy, gone, at(15, 4), fcActive), busy.active);
  // ONE LEG: nothing departs — the active leg, as before.
  const one: ChargeCycleState = { ...emptyCycle(), active: night.active };
  assert.equal(forceChargeDriftLeg(one, [], at(5, 3), () => false), one.active);
  assert.equal(cycleDriftLeg(one, at(5, 3), []), cycleDriftLeg(one, at(5, 3)));
});

/* ══ the missed apply (plan §4.8) ════════════════════════════════════════════════════════════ */

test('★★★ the missed apply: one push for a leg the overnight-only cycle never had; the overnight cost leg stays silent', () => {
  const c = twoLeg();
  const cost = c.pendingLegs[0];
  const late = COST.startMs + APPLY_LATE_MS + 1;
  assert.equal(missedApplyDue(cost, COST.startMs + APPLY_LATE_MS), false, 'the apply window is still open');
  assert.equal(missedApplyDue(cost, late), true);
  assert.equal(missedApplyDue(c.active, BACKUP.startMs + APPLY_LATE_MS + 1), true, 'the backup leg too');
  for (const s of [
    { ...cost, cancelled: true }, { ...cost, applyAttemptedAtMs: COST.startMs }, applied(cost, COST.startMs),
    { ...cost, missedApplyPushedAtMs: late }, { ...cost, announcedAtMs: null }, { ...cost, day: null },
  ]) assert.equal(missedApplyDue(s, late), false);
  // ★ ONE LEG: the overnight cost leg never sends it (only a write that never took effect pushes).
  const overnight = asChargeLeg({ ...emptyActuationState(), day: '2026-10-13', announcedAtMs: 1, targetPct: 50, windowStartMs: phx(2026, 10, 13, 23), windowEndMs: phx(2026, 10, 14, 5) });
  for (let t = phx(2026, 10, 13, 22); t < phx(2026, 10, 15, 0); t += 10 * MIN) assert.equal(missedApplyDue(overnight, t), false);
});

test('★★ the missed apply names why, in decideActuation\'s order, after the cycle\'s own reason', () => {
  const c = twoLeg();
  const cost = applied(c.pendingLegs[0], COST.startMs);
  const leg = c.pendingLegs[0];
  const ctx = { blockedBy: null, mode: 'supervised' as const, vitalsRed: false, socCoherent: true, currentReservePct: 16, panelBlock: null };
  const at = (h: number) => phx(2026, 11, 16, h);
  assert.equal(missedApplyReason(leg, { ...ctx, blockedBy: applied(c.active) }),
    `the outage backup before it still held the reserve (the ${DAY} reserve write is still applied and not yet restored)`);
  assert.equal(missedApplyReason(leg, { ...ctx, blockedBy: reverted(applied(c.active), at(5), false) }),
    'the outage backup before it was restored but the panel had not confirmed it');
  assert.equal(missedApplyReason(leg, { ...ctx, blockedBy: { ...cost, leg: 'cost' } }), `the leg before it still held the reserve (the ${DAY} reserve write is still applied and not yet restored)`);
  assert.equal(missedApplyReason(leg, { ...ctx, mode: 'advisory' }), 'the night-charge mode is advisory');
  assert.equal(missedApplyReason({ ...leg, nextOnPeakStartMs: COST.startMs + 30 * MIN }, ctx), 'its window opens within an hour of on-peak');
  assert.equal(missedApplyReason(leg, { ...ctx, vitalsRed: true }), 'the add-on\'s host was under critical load');
  assert.equal(missedApplyReason(leg, { ...ctx, socCoherent: false }), 'the pool\'s charge reading was incoherent');
  assert.equal(missedApplyReason(leg, { ...ctx, currentReservePct: null }), 'the panel did not report its backup reserve');
  assert.equal(missedApplyReason(leg, { ...ctx, currentReservePct: 0 }), 'the backup reserve read 0%, outside the 10–50% the add-on writes');
  assert.equal(missedApplyReason(leg, { ...ctx, currentReservePct: 50 }), 'the backup reserve already read 50%, at or above the 50% this charge sets');
  assert.equal(missedApplyReason(leg, { ...ctx, panelBlock: 'two smart panels stand and none is pinned' }), 'two smart panels stand and none is pinned');
  assert.equal(missedApplyReason(leg, ctx), 'no write was issued in the 30 minutes after the window opened');
  assert.equal(MISSED_APPLY_FALLBACK_REASON, 'no write was issued in the 30 minutes after the window opened');
});

test('★★ the missed-apply push: the plan\'s words, the reserve in force, an info push once per leg', () => {
  const c = twoLeg();
  const m = buildNightChargeMissedApply({
    day: DAY, role: 'cost', windowStartMs: COST.startMs, windowEndMs: COST.endMs,
    reason: 'the panel did not report its backup reserve', reservePct: 16, nowMs: COST.startMs + 31 * MIN,
  });
  assert.equal(m.severity, 'info');
  assert.equal(m.dedupId, 'night_charge_missed_apply_cost');
  assert.equal(m.title, 'Charge plan: today\'s charge did not start');
  assert.equal(m.body, 'Today\'s 10am–3pm charge did not start — the panel did not report its backup reserve. Nothing was written; the reserve stays at 16%.');
  const b = buildNightChargeMissedApply({
    day: DAY, role: 'backup', windowStartMs: c.active.windowStartMs!, windowEndMs: c.active.windowEndMs!,
    reason: 'x', reservePct: null, nowMs: c.active.windowStartMs! + 31 * MIN,
  });
  assert.equal(b.body, 'Tonight\'s 12am–5am outage backup did not start — x. Nothing was written; the reserve was not changed.');
  assert.equal(b.title, 'Charge plan: tonight\'s outage backup did not start', 'a window before dawn is tonight\'s');
  const tue = buildNightChargeMissedApply({
    day: DAY, role: 'backup', windowStartMs: phx(2026, 11, 17, 23), windowEndMs: phx(2026, 11, 18, 5),
    reason: 'x', reservePct: 20, nowMs: phx(2026, 11, 17, 23, 31),
  });
  assert.equal(tue.title, 'Charge plan: tonight\'s outage backup did not start');
  assert.match(tue.body, /^Tonight's 11pm–5am outage backup did not start/);
  const later = buildNightChargeMissedApply({ day: DAY, role: 'cost', windowStartMs: COST.startMs, windowEndMs: COST.endMs, reason: 'x', reservePct: 16, nowMs: COST.startMs + 26 * H });
  assert.equal(later.title, 'Charge plan: Monday\'s charge did not start');
  assert.ok(!/kWh/.test(m.body), 'no figure at all, never the worst case');
});

/* ══ the ledger, per leg ═════════════════════════════════════════════════════════════════════ */

test('★★ a leg\'s stamps go to its own columns: the cost leg\'s as ever, a backup leg\'s to backup_*', () => {
  const f = { actuated: 1, actuation_applied_at_ms: 5, actuation_reverted_at_ms: 6, arm_disposition: 'x', force_charge_on_at_ms: 7, revert_deadline_paged_at_ms: 8 };
  assert.equal(legLedgerFields('cost', f), f, 'unchanged, the same object');
  assert.deepEqual(legLedgerFields('backup', f), { backup_actuated: 1, backup_applied_at_ms: 5, backup_reverted_at_ms: 6, backup_arm_disposition: 'x' });
  const cols = new Set(CHARGE_CYCLE_LEDGER_SCHEMA.map(([c]) => c as string));
  for (const c of Object.values(BACKUP_LEDGER_COLUMN)) assert.ok(cols.has(c), `${c} is a ledger column`);
});

/* ══ a year of one-leg nights: the cycle is the per-night record, unchanged ══════════════════ */

test('★★★ ONE LEG, a year of evenings: armed as armFromPlan arms, persisted and read back unchanged, never promoted, missed or pushed', () => {
  const periodIdAt = (t: number) => rateAt(REV, t).periodId;
  let nights = 0;
  for (let d = Date.UTC(2026, 9, 15); d < Date.UTC(2027, 9, 15); d += 86_400_000) {
    const y = new Date(d).getUTCFullYear(), mo = new Date(d).getUTCMonth() + 1, dd = new Date(d).getUTCDate();
    const now = phx(y, mo, dd, 21, 30);
    const w = resolveCheapWindow(periodIdAt, now, APS_PERIOD.OVERNIGHT, 30);
    if (!w) continue;
    const day = new Date(d).toISOString().slice(0, 10);
    const p = plan(w, { setpointSocPct: 94, costCeilingSocPct: 80, buyKwh: 40 });
    const peak = nextOnPeakStartMs(REV, w.startMs);
    const r = armCycle(emptyCycle(), day, [{ role: 'cost', kind: 'overnight', plan: p, forceChargeEnabled: true, nextOnPeakStartMs: peak }], now, 16);
    const want = armFromPlan(emptyActuationState(), day, p, now, 16, true, peak)!;
    assert.deepEqual(coerceActuationState(r.cycle!.active), want, day);
    // Through the night: every stage persists and reads back as the record itself.
    for (const s of [r.cycle!.active, applied(r.cycle!.active), reverted(applied(r.cycle!.active)), forceChargeOffOpen(reverted(applied(r.cycle!.active)))]) {
      const c: ChargeCycleState = { ...emptyCycle(), active: s };
      const back = coerceCycle(JSON.parse(JSON.stringify(serializeCycle(c))));
      assert.deepEqual(back, c, day);
      assert.deepEqual(coerceActuationState(back.active), coerceActuationState(JSON.parse(JSON.stringify(s))));
      for (const t of [w.startMs - H, w.startMs + APPLY_LATE_MS + 1, w.endMs + 10 * MIN]) {
        assert.equal(promoteCycle(c, t, 16), null);
        assert.equal(missedApplyDue(s, t), false);
        assert.equal(cycleDriftLeg(c, t) != null, v1188NightActive(s, t));
      }
    }
    nights++;
  }
  assert.ok(nights > 240, `${nights} overnight windows`);
});

/* ══ index.ts wiring (not reachable from a unit test — SOURCE PINS, labelled) ═════════════════ */

const SRC = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('★★★ SOURCE PIN: the file is the cycle — read by coerceCycle, written by serializeCycle, the active leg stays the per-night record', () => {
  const idx = SRC('index.ts');
  assert.ok(idx.includes('return coerceCycle(JSON.parse(readFileSync(NIGHT_CHARGE_ACTUATION_PATH, \'utf8\')));'));
  assert.ok(idx.includes('let nightActuationMem: ChargeLegState = nightCycleAtBoot.active;'));
  assert.ok(idx.includes('atomicWriteFileSync(NIGHT_CHARGE_ACTUATION_PATH, JSON.stringify(serializeCycle(nightCycleView())));'));
  assert.ok(!idx.includes('JSON.stringify(s));\n  } catch (e: any) {\n    app.log.debug(`night-charge: actuation persist failed'), 'never the bare record');
  const persist = idx.slice(idx.indexOf('function persistNightActuation('), idx.indexOf('function persistCycle('));
  assert.ok(persist.includes('nightActuationMem = asChargeLeg(s);'));
});

test('★★★ SOURCE PIN: the cycle is armed by armCycle and persisted only once an announcement channel delivered it', () => {
  const idx = SRC('index.ts');
  const job = idx.slice(idx.indexOf('async function runNightChargeEveningJobInner('), idx.indexOf('function repairPrematureNightOutcomes('));
  const arm = job.indexOf('const arm = armCycle(nightCycleView(), today, [{');
  const persist = job.indexOf('persistCycle(withLiveTrailing(armedCycle!, nightActuationMem));');
  const gate = job.indexOf('if (haNotifyDelivered || audibleDelivered) {');
  const send = job.indexOf('await sendNotification(cfg, msg);');
  assert.ok(arm > 0 && send > arm && gate > send && persist > gate, 'arm → announce → delivered? → persist');
  assert.equal((job.match(/persistCycle\(/g) ?? []).length, 1, 'nowhere else');
  assert.ok(!job.includes('persistNightActuation(armedCandidate)'));
  // A prior cycle's pending leg is stamped superseded only once the cycle replacing it is persisted:
  // an undelivered arm replaces nothing.
  const listed = job.indexOf('supersededPending = supersededLegs(nightCycleView(), arm.legs, today, nowMs)');
  const stamped = job.indexOf("stampLegOutcome(leg, { arm_disposition: `superseded by the ${today} plan` });");
  assert.ok(listed > arm && listed < send, 'listed at the arm');
  assert.ok(stamped > persist, 'stamped after the persist');
  const loop = job.indexOf('        for (const { leg, sharedWindow } of supersededPending) {\n');
  assert.ok(loop > persist && loop < stamped, 'each leg listed at the arm is stamped');
  // A stale prior arm takes its pending legs with it (with nothing active they would be promoted).
  const stale = idx.slice(idx.indexOf('function cancelStalePriorArm('), idx.indexOf('async function runNightChargeEveningJobInner('));
  assert.ok(stale.indexOf('nightCyclePending = [];') > 0 && stale.indexOf('nightCyclePending = [];') < stale.indexOf('persistNightActuation(emptyActuationState());'));
});

test('★★★ SOURCE PIN: the tick runs the trailing leg and the cycle step before the actuator steps, and the missed apply after', () => {
  const idx = SRC('index.ts');
  const tick = idx.slice(idx.indexOf('async function runNightActuationTick(): Promise<void> {'), idx.indexOf('/** v1.166.0 — reasons already logged'));
  const trailing = tick.indexOf('try { await runTrailingLegTick(); }');
  const step = tick.indexOf('try { runCycleStep(); }');
  const steps = tick.indexOf('await runActuationSteps(actuationStepOrder(nightActuationMem, Date.now()), {');
  const missed = tick.indexOf('try { await runMissedApplyStep(); }');
  assert.ok(trailing > 0 && step > trailing && steps > step && missed > steps, 'trailing OFF → promotion → reserve/force-charge → missed apply');
  assert.ok(tick.indexOf('nightActuationInFlight = false;') > missed, 'all inside the in-flight latch');
  // The promotion reads a FRESH reserve readback for the never-landed proof.
  assert.ok(idx.includes('const step = promoteCycle(nightCycleView(), nowMs, freshReserveReadingPct(nowMs));'));
  // The trailing leg is driven by the same decision with force-charge DISABLED: it only switches OFF.
  const tr = idx.slice(idx.indexOf('async function runTrailingLegTick('), idx.indexOf('async function runMissedApplyStep('));
  assert.equal((tr.match(/enabled: false,/g) ?? []).length, 2, 'both the blind and the live decision');
  assert.ok(!tr.includes('on: true'), 'never an ON write');
  assert.ok(tr.includes('await escalateForceChargeStuck(t, action, TRAILING_LEG);'));
  assert.ok(tr.includes('await escalateForceChargeStuck(t, blind, TRAILING_LEG);'));
  // Both force-charge steps bound blind OFF re-sends by the next cost leg's open (nextForceChargeOpenMs).
  assert.ok(tr.includes('nextLegOpenMs: nextForceChargeOpenMs(t, [nightActuationMem, ...nightCyclePending], getLatestNightChargePlan()?.window?.startMs),'));
  assert.ok(idx.includes('nextLegOpenMs: nextForceChargeOpenMs(state, nightCyclePending, fcPlan?.window?.startMs),'));
  // The missed apply is stamped before it is pushed, and the push is not awaited.
  const ma = idx.slice(idx.indexOf('async function runMissedApplyStep('), idx.indexOf('\nif (nightChargeEnabled) {'));
  const stampAt = ma.indexOf('const stamped: ChargeLegState = { ...leg, missedApplyPushedAtMs: nowMs };');
  const pushAt = ma.indexOf('void sendNotification(loadNotifyConfig(), buildNightChargeMissedApply({');
  assert.ok(stampAt > 0 && pushAt > stampAt, 'stamped, then pushed');
  assert.ok(ma.indexOf('else persistNightActuation(stamped);') > stampAt && ma.indexOf('else persistNightActuation(stamped);') < pushAt);
  assert.ok(!ma.includes('await sendNotification('));
  // The stamp does not wait on the guard readings: a throw gathering them leaves the fallback reason.
  const tryAt = ma.indexOf('  try {\n    const shp2 = findShp2(store.get().devices);');
  assert.ok(ma.includes('let reason = MISSED_APPLY_FALLBACK_REASON;') && tryAt > 0 && tryAt < stampAt);
  // The safety tick (master switch off) also switches a trailing leg's force-charge off.
  const safety = idx.slice(idx.indexOf('const forceChargeSafetyTick = setInterval('), idx.indexOf('forceChargeSafetyTick.unref();'));
  assert.ok(safety.includes('runTrailingLegTick()'));
  // A backup leg never force-charges, whatever the option says.
  assert.ok(idx.includes('enabled: !opts.forceDisabled && forceChargeOn(legRoleOf(state)),'));
});

test('★★★ SOURCE PIN: the cancel route takes { leg }, the status route serves legs[], drift attribution is per leg, stamps go to the leg\'s columns', () => {
  const idx = SRC('index.ts');
  const route = idx.slice(idx.indexOf("app.post('/api/night-charge/cancel'"), idx.indexOf('// v1.184.0 — the operator\'s "the grid is back"'));
  assert.ok(route.includes('const want = parseCancelLeg(req.body);'));
  assert.ok(route.includes('if (want === undefined) {\n    reply.code(400);'));
  assert.ok(route.includes('const r = cancelLeg(nightCycleView(), want);'));
  assert.ok(route.includes('persistCycle(r.cycle);'));
  const status = idx.slice(idx.indexOf("app.get('/api/night-charge/status'"), idx.indexOf("app.post('/api/night-charge/cancel'"));
  assert.ok(status.includes('legs: cycleLegsStatus(nightCycleView(), Date.now()),'));
  const drift = idx.slice(idx.indexOf('function driftActuatorContext('), idx.indexOf('function forceChargeDriftActive('));
  assert.ok(drift.includes('const own = cycleDriftLeg(nightCycleView(), nowMs, nightCycleDeparted);'));
  assert.ok(drift.includes('const nightActive = own != null;'));
  assert.ok(drift.includes('targetPct: reserveLeg.targetPct, priorReservePct: reserveLeg.priorReservePct, nightActive,'));
  assert.ok(drift.includes('const act = forceChargeDriftLeg(nightCycleView(), nightCycleDeparted, nowMs, (l) => forceChargeDriftActive(l, nowMs));'));
  // The legs a cycle step takes out are kept for the drift tail.
  const step = idx.slice(idx.indexOf('function runCycleStep('), idx.indexOf('function runCycleStep(') + 1200);
  assert.ok(step.includes('persistCycle(step.cycle);\n  nightCycleDeparted = departedAfterStep(nightCycleDeparted, step, nowMs);'));
  // Every reserve-tick ledger stamp goes through the leg (a backup leg's to backup_*).
  const inner = idx.slice(idx.indexOf('async function runNightActuationTickInner('), idx.indexOf('function runCycleStep('));
  assert.ok(!inner.includes('recorder.recordNightOutcome('), 'no direct stamp');
  assert.equal((inner.match(/stampLegOutcome\(state, /g) ?? []).length, 4);
  // The plan row records the cost leg's window kind.
  assert.ok(idx.includes("    window_kind: 'overnight',\n  };"));
});
