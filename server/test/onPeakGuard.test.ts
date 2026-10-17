/**
 * R1 (v1.189.0) — the night-charge write's failure paths, bounded against on-peak.
 *
 * A raise left standing into the on-peak period is the expensive end state: the panel holds the
 * raised reserve as its floor, or keeps force-charging, and buys grid power at the day's highest
 * rate. Each armed night now carries the start of the on-peak period after its window
 * (nextOnPeakStartMs), and:
 *  - no raise from an hour before it (apply, re-issues, ceiling sync, ON, ON re-issue); the
 *    restore and the force-charge OFF fall due then at the latest (writeWindowEndMs, revertDueMs);
 *  - the force-charge OFF deadline is capped half an hour before it; blind OFF re-sends stop at
 *    the next window's open;
 *  - revertDeadline: an unconfirmed restore pages (critical, spoken and pushed) at
 *    min(close + 30 min, on-peak − 30 min) and again at the on-peak start — only while the panel
 *    reads our target or nothing;
 *  - the foreign rule: a reserve someone else set is left alone, on two readings 5 min apart;
 *  - heldByChargeWrite: the on-peak money detectors measure against the prior floor while a
 *    restore that did not take leaves our target standing;
 *  - /api/reserve-floor names the restore time.
 * The overnight window ends at 05:00, eleven hours before the 16:00 on-peak start: a night that
 * goes to plan is byte-identical, which the year-long replay below pins.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  armFromPlan, armRefusalReason, decideActuation, emptyActuationState, coerceActuationState,
  writeWindowEndMs, revertDueMs, onPeakGuardStartMs, onPeakGuardActive,
  ON_PEAK_RAISE_GUARD_MS, ON_PEAK_PAGE_LEAD_MS, REVERT_DEADLINE_AFTER_WINDOW_MS, FOREIGN_RESERVE_SETTLE_MS,
  APPLY_VERIFY_AFTER_MS, APPLY_LATE_MS, REVERT_READBACK_GRACE_MS, MAX_SPOKEN_ADVISORY_CHARS,
  REVERT_VERIFY_AFTER_MS, REVERT_MAX_RETRIES, REVERT_PAGE_STAGE_SPAN_MS,
  attemptProvedUnlanded, attemptNeverLanded, armOpenItem, restoreUnconfirmed, revertRetryPending, revertDeadlineStageDue,
  chargeWriteHeldFromMs, isOwnReserveValue, ceilingMovedPct,
  decideRevertDeadline, revertDeadlineMs, revertDeadlineSpoken, revertOutstanding, restoreTargetPct,
  foreignStep, isForeignReserveReading, isReserveArbitrageRaised, ownerReserveFloorPct,
  chargeWriteHold, moneyDetectorReservePct, reserveRestoreNote,
  isReserveSetting, applyProvedUnlanded, restoreAwaitingFirstChance, REVERT_DEADLINE_HOLD_MAX_MS, APPLY_MAX_RETRIES,
  type ArmablePlan, type ActuationTickOpts, type NightActuationState,
} from '../src/nightChargeActuator.js';
import { onPeakDayWords } from '../src/chargeText.js';
import {
  decideForceCharge, forceChargeOffDueNow, forceChargeOffDeadlineMs, actuationStepOrder, blindResendStopMs,
  FORCE_CHARGE_MIN_RUN_MS, FORCE_CHARGE_ON_RETRY_CUTOFF_MS, FORCE_CHARGE_ON_VERIFY_AFTER_MS,
  FORCE_CHARGE_BLIND_RESEND_MAX_MS, FORCE_CHARGE_OFF_PERSIST_EVERY_MS, FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS,
  type ForceChargeOpts,
} from '../src/nightForceCharge.js';
import { nextOnPeakStartMs, ON_PEAK_SCAN_HOURS } from '../src/chargeWindows.js';
import { buildApsREvModel, flatTariffModel, rateAt } from '../src/tariff.js';
import { resolveCheapWindow } from '../src/nightChargeAdvisor.js';
import {
  assessPeakDraw, peakGridDrawAlerts, classifyIdlePool, evaluateIdlePool, peakIdlePoolAlerts,
  resetIdlePoolState, resetPeakDrawOnset, IDLE_DWELL_MS, DEFAULT_PEAK_DRAW_CONFIG,
  type PeakDrawInputs,
} from '../src/peakGridDraw.js';
import { idlePoolInputsFrom } from '../src/alertMonitor.js';
import { buildNightChargeRevertDeadline, buildNightChargeForeignReserve } from '../src/notify.js';
import { armCycle, asChargeLeg, legResolved } from '../src/chargeCycle.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** A Phoenix wall-clock instant (UTC−7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h + 7, mi);
const REV = buildApsREvModel({
  confirmed: true, onPeak: { summer: 44.2, winter: 34.82 }, offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
});

/** Tue 2026-10-13 23:00 → Wed 05:00: an overnight window; on-peak Wed 16:00. */
const NIGHT = { startMs: phx(2026, 10, 13, 23), endMs: phx(2026, 10, 14, 5) };
const NIGHT_PEAK = phx(2026, 10, 14, 16);
/** Mon 2026-11-16 10:00 → 15:00: a super off-peak-shaped window; on-peak 16:00 the same day. */
const MIDDAY = { startMs: phx(2026, 11, 16, 10), endMs: phx(2026, 11, 16, 15) };
const MIDDAY_PEAK = phx(2026, 11, 16, 16);
/** Mon 2026-11-16 13:00 → 17:00: a window running into on-peak — only a guard can stop it there. */
const LATE = { startMs: phx(2026, 11, 16, 13), endMs: phx(2026, 11, 16, 17) };

const plan = (window: { startMs: number; endMs: number }, o: Partial<ArmablePlan> = {}): ArmablePlan => ({
  chargeTonight: true, basisComplete: true, buyKwh: 40, setpointSocPct: 95, costCeilingSocPct: 80, window, ...o,
});
/** Armed from `window`, with the on-peak stamp the evening job computes (stamp = false: a record
 *  armed before the stamp). */
function arm(window: { startMs: number; endMs: number }, stamp = true, armAt = window.startMs - 90 * MIN): NightActuationState {
  const s = armFromPlan(emptyActuationState(), '2026-10-13', plan(window), armAt, 16, true,
    stamp ? nextOnPeakStartMs(REV, window.startMs) : undefined);
  assert.ok(s, 'fixture plan must arm');
  return s!;
}
/** Applied at the open and read back, prior 16. */
const applied = (s: NightActuationState, o: Partial<NightActuationState> = {}): NightActuationState => ({
  ...s, applyAttemptedAtMs: s.windowStartMs, attemptBaselinePct: 16, appliedAtMs: s.windowStartMs,
  priorReservePct: 16, applyVerifiedAtMs: s.windowStartMs! + MIN, ...o,
});
const ropts = (o: Partial<ActuationTickOpts> = {}): ActuationTickOpts => ({
  mode: 'supervised', writeReady: false, currentReservePct: 16, socCoherent: true, vitalsRed: false, gridPresent: true, ...o,
});
const fopts = (o: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
  enabled: true, gridPresent: true, gridStaLost: false, ceilingReadbackPct: 80, slotsOn: [],
  connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true, poolSocPct: 45, fullKwh: 92.16, chargeRateKw: 14, ...o,
});

beforeEach(() => { resetIdlePoolState(); resetPeakDrawOnset(); });

/* ══ the stamp: chargeWindows.nextOnPeakStartMs ══ */

test('★★★ nextOnPeakStartMs: the first on-peak hour at or after the instant, across weekends and R-EV holidays', () => {
  assert.equal(nextOnPeakStartMs(REV, NIGHT.startMs), NIGHT_PEAK, 'Tue 23:00 → Wed 16:00');
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 10, 13, 21, 30)), phx(2026, 10, 14, 16), 'the 21:30 arm sees the same start');
  assert.equal(nextOnPeakStartMs(REV, MIDDAY.startMs), MIDDAY_PEAK, 'a 10:00 open → 16:00 the same day');
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 10, 16, 23)), phx(2026, 10, 19, 16), 'Friday night → Monday 16:00');
  // Columbus Day, Mon 2026-10-12, is all-day off-peak: Friday's next on-peak is Tuesday.
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 10, 9, 23)), phx(2026, 10, 13, 16), 'a holiday Monday → Tuesday');
  // Christmas Eve (Thu) and Christmas Day (Fri) 2026: Wednesday night's next on-peak is Monday.
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 12, 23, 23)), phx(2026, 12, 28, 16), 'the longest holiday run');
  // Inside an on-peak period: the start of that period — a leg armed there is guarded at once.
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 10, 14, 17, 30)), phx(2026, 10, 14, 16));
  // A flat tariff has no on-peak period: no stamp, the window-only schedule.
  assert.equal(nextOnPeakStartMs(flatTariffModel(17), NIGHT.startMs), null);
  // Bounded: Friday 23:00 with a one-day scan finds nothing (Monday is 65 h out).
  assert.equal(nextOnPeakStartMs(REV, phx(2026, 10, 16, 23), 24), null);
  assert.ok(ON_PEAK_SCAN_HOURS >= 5 * 24 + 17, 'the scan reaches past the Christmas run');
  assert.equal(nextOnPeakStartMs(REV, Number.NaN), null);
});

test('★★ the arm stamps it, the record keeps it across a restart, and a record without it keeps the window-only schedule', () => {
  const s = arm(NIGHT);
  assert.equal(s.nextOnPeakStartMs, NIGHT_PEAK);
  assert.equal(coerceActuationState(JSON.parse(JSON.stringify(s))).nextOnPeakStartMs, NIGHT_PEAK);
  const legacy = arm(NIGHT, false);
  assert.equal(legacy.nextOnPeakStartMs, null);
  assert.equal(coerceActuationState({ ...JSON.parse(JSON.stringify(legacy)), nextOnPeakStartMs: 'x' }).nextOnPeakStartMs, null);
  assert.equal(writeWindowEndMs(legacy), NIGHT.endMs);
  assert.equal(revertDueMs(legacy), NIGHT.endMs);
  assert.equal(onPeakGuardStartMs(legacy), null);
  assert.equal(onPeakGuardActive(legacy, NIGHT_PEAK + HOUR), false, 'no stamp, no guard');
});

/* ══ ★★★ the success path is byte-identical ══ */

/**
 * One night, tick by tick, against a device that takes every write a minute later: the reserve
 * decision, the revertDeadline decision and the force-charge decision, each applied to the record
 * as the integrator applies it. Returns every decision as text, so two records can be compared
 * decision for decision.
 */
function replayNight(armed: NightActuationState, fcEnabled: boolean): string[] {
  let s = armed;
  const dev = {
    reserve: 16, pool: 30, slots: [] as number[], ceiling: 100,
    pend: [] as Array<{ at: number; apply: () => void }>,
  };
  const later = (at: number, apply: () => void) => dev.pend.push({ at, apply });
  const out: string[] = [];
  for (let t = armed.windowStartMs! - 10 * MIN; t <= armed.windowEndMs! + 40 * MIN; t += MIN) {
    for (const p of dev.pend.filter((x) => t >= x.at)) p.apply();
    dev.pend = dev.pend.filter((x) => t < x.at);
    dev.pool = dev.slots.length > 0 || dev.reserve > dev.pool ? Math.min(100, dev.pool + 0.25) : Math.max(0, dev.pool - 0.02);
    const a = decideActuation(s, t, ropts({ currentReservePct: dev.reserve }));
    const d = decideRevertDeadline(s, t, dev.reserve, true);
    out.push(`${t} reserve ${JSON.stringify(a)} deadline ${JSON.stringify(d)}`);
    switch (a.kind) {
      case 'none': break;
      case 'apply': {
        s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: dev.reserve, appliedAtMs: t, priorReservePct: dev.reserve };
        const v = a.targetPct; later(t + MIN, () => { dev.reserve = v; }); break;
      }
      case 'applyVerified': s = { ...s, applyVerifiedAtMs: t }; break;
      case 'revert': { s = { ...s, revertedAtMs: t }; const v = a.restorePct; later(t + MIN, () => { dev.reserve = v; }); break; }
      case 'revertVerified': s = { ...s, revertVerifiedAtMs: t }; break;
      default: throw new Error(`not a success-path decision: ${JSON.stringify(a)}`);
    }
    const f = decideForceCharge(s, t, fopts({
      enabled: fcEnabled, ceilingReadbackPct: dev.ceiling, slotsOn: [...dev.slots], poolSocPct: Math.round(dev.pool),
    }));
    out.push(`${t} fc ${JSON.stringify(f)}`);
    switch (f.kind) {
      case 'none': break;
      case 'syncCeiling': {
        s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? f.prior };
        const v = f.pct; later(t + MIN, () => { dev.ceiling = v; }); break;
      }
      case 'on': {
        s = { ...s, forceChargeOnAtMs: t, forceChargeSlots: f.slots, forceChargeOnLastAttemptMs: t };
        const v = [...f.slots]; later(t + MIN, () => { dev.slots = v; }); break;
      }
      case 'onVerified': s = { ...s, forceChargeOnVerifiedAtMs: t }; break;
      case 'off': {
        s = { ...s, forceChargeOffAtMs: t, forceChargeOffLastAttemptMs: t, forceChargeOffReason: f.reason };
        later(t + MIN, () => { dev.slots = []; }); break;
      }
      case 'offVerified': s = { ...s, forceChargeOffVerifiedAtMs: t }; break;
      case 'restoreCeiling': {
        s = { ...s, forceChargeCeilingRestoreAttempts: s.forceChargeCeilingRestoreAttempts + 1, forceChargeCeilingRestoreLastAttemptMs: t };
        const v = f.pct; later(t + MIN, () => { dev.ceiling = v; }); break;
      }
      case 'ceilingRestored': s = { ...s, forceChargeCeilingRestoredAtMs: t }; break;
      default: throw new Error(`not a success-path decision: ${JSON.stringify(f)}`);
    }
  }
  return out;
}

test('★★★ a year of overnight nights that go to plan: every decision is the one the window-only schedule makes', () => {
  const seen = new Set<number>();
  let nights = 0;
  let forceCharged = 0;
  for (let d = 0; d < 365; d++) {
    const armAt = phx(2026, 10, 15, 21, 30) + d * 24 * HOUR;
    const w = resolveCheapWindow((t) => rateAt(REV, t).periodId, armAt, 'overnight', 30);
    if (!w || seen.has(w.startMs)) continue;
    seen.add(w.startMs);
    const stamped = arm(w, true, armAt);
    const legacy = arm(w, false, armAt);
    const peak = stamped.nextOnPeakStartMs!;
    assert.ok(peak - w.endMs >= 11 * HOUR, `${new Date(w.endMs).toISOString()}: on-peak is 11 h or more after the close`);
    assert.equal(writeWindowEndMs(stamped), w.endMs);
    assert.equal(revertDueMs(stamped), w.endMs);
    assert.equal(revertDeadlineMs(stamped), w.endMs + REVERT_DEADLINE_AFTER_WINDOW_MS);
    const on = { ...stamped, forceChargeOnAtMs: w.endMs - HOUR };
    assert.equal(forceChargeOffDeadlineMs(on), forceChargeOffDeadlineMs({ ...on, nextOnPeakStartMs: null }), 'the OFF deadline is unchanged');
    for (const fc of [true, false]) {
      const a = replayNight(stamped, fc);
      const b = replayNight(legacy, fc);
      assert.deepEqual(a, b, `${new Date(w.startMs).toISOString()} (force-charge ${fc}): a decision moved`);
      const text = a.join('\n');
      assert.ok(text.includes('"kind":"apply"') && text.includes('"kind":"revert"') && text.includes('"kind":"revertVerified"'));
      assert.ok(!text.includes('"kind":"page"'), 'no revertDeadline page on a night that goes to plan');
      assert.ok(!text.includes('"kind":"hold"'), 'nor a wait: the 05:00 restore read back long before the deadline');
      if (fc && text.includes('"kind":"on"')) {
        forceCharged++;
        assert.ok(text.includes('"kind":"off"') && text.includes('"kind":"offVerified"') && text.includes('"kind":"ceilingRestored"'));
      }
    }
    nights++;
  }
  assert.ok(nights >= 250, `every weekday window of the year (${nights})`);
  assert.ok(forceCharged >= 200, `the force-charge leg ran on most of them (${forceCharged})`);
});

/* ══ 1. the on-peak guard ══ */

test('★★★ no apply from an hour before on-peak, even inside the apply window', () => {
  // A window opening at 14:50, on-peak at 16:00: the guard starts at 15:00.
  const w = { startMs: phx(2026, 11, 16, 14, 50), endMs: phx(2026, 11, 16, 15, 50) };
  const s = arm(w);
  assert.equal(s.nextOnPeakStartMs, MIDDAY_PEAK);
  assert.deepEqual(decideActuation(s, phx(2026, 11, 16, 14, 59), ropts()), { kind: 'apply', targetPct: 50 });
  assert.equal(decideActuation(s, phx(2026, 11, 16, 15), ropts()).kind, 'none', 'the guard');
  assert.equal(decideActuation(s, w.startMs + APPLY_LATE_MS, ropts()).kind, 'none');
  // Without the stamp the apply window alone decides: the write would land at 15:00-15:20.
  assert.deepEqual(decideActuation(arm(w, false), phx(2026, 11, 16, 15), ropts()), { kind: 'apply', targetPct: 50 });
});

test('★★★ the restore falls due an hour before on-peak when the window runs past it', () => {
  const s = applied(arm(LATE));
  const live = ropts({ currentReservePct: 50 });
  assert.equal(revertDueMs(s), phx(2026, 11, 16, 15));
  assert.equal(decideActuation(s, phx(2026, 11, 16, 14, 59), live).kind, 'none');
  assert.deepEqual(decideActuation(s, phx(2026, 11, 16, 15), live), { kind: 'revert', restorePct: 16 });
  // A record without the stamp held it to the window close, into on-peak.
  assert.equal(decideActuation(applied(arm(LATE, false)), phx(2026, 11, 16, 16), live).kind, 'none');
  // The window close still binds when it comes first.
  assert.deepEqual(decideActuation(applied(arm(MIDDAY)), MIDDAY.endMs, live), { kind: 'revert', restorePct: 16 });
  assert.equal(revertDueMs(applied(arm(MIDDAY))), MIDDAY.endMs);
});

test('★★ no apply re-issue within the verify grace of the guard: the failure is reported instead', () => {
  const s = { ...applied(arm(LATE)), applyVerifiedAtMs: null, appliedAtMs: phx(2026, 11, 16, 14, 40), applyLastAttemptMs: null };
  const failing = ropts({ currentReservePct: 16 });
  assert.deepEqual(decideActuation(s, phx(2026, 11, 16, 14, 54), failing), { kind: 'retryApply', targetPct: 50 });
  assert.equal(decideActuation(s, phx(2026, 11, 16, 14, 55), failing).kind, 'applyFailed', 'guard − verify grace');
  // Without the stamp the closing window alone bounds it (17:00 − 5 min).
  assert.equal(decideActuation({ ...s, nextOnPeakStartMs: null }, phx(2026, 11, 16, 14, 55), failing).kind, 'retryApply');
  assert.equal(writeWindowEndMs(s), phx(2026, 11, 16, 15));
});

test('★★★ force-charge: no ceiling sync or ON within the minimum run of the guard, and the start is timed to it', () => {
  const s = applied(arm(LATE));
  const guard = phx(2026, 11, 16, 15);
  // Ceiling sync (the first force-charge raise) stops MIN_RUN before the guard, not the window.
  const unsynced = fopts({ ceilingReadbackPct: 100 });
  assert.equal(decideForceCharge(s, guard - FORCE_CHARGE_MIN_RUN_MS - 1, unsynced).kind, 'syncCeiling');
  const late = decideForceCharge(s, guard - FORCE_CHARGE_MIN_RUN_MS, unsynced);
  assert.equal(late.kind, 'none');
  assert.match((late as { why?: string }).why ?? '', /on-peak guard/);
  assert.equal(decideForceCharge({ ...s, nextOnPeakStartMs: null }, guard - FORCE_CHARGE_MIN_RUN_MS, unsynced).kind, 'syncCeiling');
  // The just-in-time start counts back from the guard: from 45% to 80% at 14 kW is ~2.3 h + 15 min.
  const synced = fopts({ poolSocPct: 45 });
  assert.equal(decideForceCharge(s, guard - 2 * HOUR, synced).kind, 'on');
  assert.equal(decideForceCharge({ ...s, nextOnPeakStartMs: null }, guard - 2 * HOUR, synced).kind, 'none', 'timed to 17:00 it would wait');
});

test('★★★ force-charge OFF falls due at the guard (reason onPeakGuard), first in the tick', () => {
  const s = { ...applied(arm(LATE)), forceChargeOnAtMs: phx(2026, 11, 16, 13, 30), forceChargeSlots: [1, 2, 3] };
  const guard = phx(2026, 11, 16, 15);
  assert.equal(decideForceCharge(s, guard - 1, fopts({ slotsOn: [1, 2, 3], poolSocPct: 60 })).kind, 'onVerified');
  assert.deepEqual(decideForceCharge(s, guard, fopts({ slotsOn: [1, 2, 3], poolSocPct: 60 })), { kind: 'off', slots: [1, 2, 3], reason: 'onPeakGuard' });
  assert.equal(forceChargeOffDueNow(s, guard - 1), false);
  assert.equal(forceChargeOffDueNow(s, guard), true);
  assert.deepEqual(actuationStepOrder(s, guard), ['forceCharge', 'reserve']);
  // The window close keeps its own reason when it comes first.
  const m = { ...applied(arm(MIDDAY)), forceChargeOnAtMs: MIDDAY.endMs - HOUR, forceChargeSlots: [1] };
  assert.deepEqual(decideForceCharge(m, MIDDAY.endMs, fopts({ slotsOn: [1] })), { kind: 'off', slots: [1], reason: 'windowEnd' });
  // Without the stamp it rode on to 17:00.
  assert.equal(forceChargeOffDueNow({ ...s, nextOnPeakStartMs: null }, guard), false);
});

test('★★ no ON re-issue within the cutoff of the guard: the warning goes instead', () => {
  const guard = phx(2026, 11, 16, 15);
  const onAt = guard - FORCE_CHARGE_ON_RETRY_CUTOFF_MS - FORCE_CHARGE_ON_VERIFY_AFTER_MS - MIN;
  const s = { ...applied(arm(LATE)), forceChargeOnAtMs: onAt, forceChargeOnLastAttemptMs: onAt, forceChargeSlots: [1, 2] };
  const notOn = fopts({ slotsOn: [1], poolSocPct: 60 });
  assert.deepEqual(decideForceCharge(s, guard - FORCE_CHARGE_ON_RETRY_CUTOFF_MS - 1, notOn), { kind: 'onRetry', slots: [2] });
  assert.deepEqual(decideForceCharge(s, guard - FORCE_CHARGE_ON_RETRY_CUTOFF_MS, notOn), { kind: 'onFailed', slots: [2], noRetry: true });
  assert.deepEqual(decideForceCharge({ ...s, nextOnPeakStartMs: null }, guard - FORCE_CHARGE_ON_RETRY_CUTOFF_MS, notOn), { kind: 'onRetry', slots: [2] });
});

test('★★ the panel\'s own ceiling comes back at the guard on a night whose force-charge never started', () => {
  const s = { ...applied(arm(LATE)), forceChargeCeilingAttemptedAtMs: LATE.startMs + 2 * MIN, forceChargeCeilingPriorPct: 100 };
  const guard = phx(2026, 11, 16, 15);
  assert.equal(decideForceCharge(s, guard - 1, fopts({ ceilingReadbackPct: 80, poolSocPct: 85 })).kind, 'none');
  assert.deepEqual(decideForceCharge(s, guard, fopts({ ceilingReadbackPct: 80, poolSocPct: 85 })), { kind: 'restoreCeiling', pct: 100, lastAttempt: false });
});

/* ══ 2. the OFF deadline and blind re-sends ══ */

test('★★★ the force-charge OFF deadline is capped half an hour before on-peak: 15:30, not 16:00', () => {
  const s = { ...applied(arm(MIDDAY)), forceChargeOnAtMs: MIDDAY.endMs - HOUR, forceChargeSlots: [1, 2, 3], forceChargeOffAtMs: MIDDAY.endMs };
  assert.equal(forceChargeOffDeadlineMs(s), MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS);
  assert.equal(forceChargeOffDeadlineMs({ ...s, nextOnPeakStartMs: null }), MIDDAY.endMs + FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS, 'uncapped: 16:00');
  // It pages at 15:30 with no readback (the cloud-dark panel), where it waited for 16:00.
  const blind = fopts({ slotsOn: null });
  assert.equal(decideForceCharge(s, MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS - 1, blind).kind, 'none');
  assert.deepEqual(decideForceCharge(s, MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS, blind), { kind: 'offFailed', slots: [1, 2, 3], deadline: true, unconfirmed: true });
  // The overnight deadline (06:00) is far inside the cap.
  const n = { ...applied(arm(NIGHT)), forceChargeOnAtMs: NIGHT.endMs - HOUR, forceChargeSlots: [1] };
  assert.equal(forceChargeOffDeadlineMs(n), NIGHT.endMs + FORCE_CHARGE_OFF_DEADLINE_AFTER_WINDOW_MS);
});

test('★★★ blind OFF re-sends stop at the next window\'s open when it comes before the 12 h bound', () => {
  const off = MIDDAY.endMs;
  const s = {
    ...applied(arm(MIDDAY)), forceChargeOnAtMs: off - HOUR, forceChargeSlots: [1, 2, 3], forceChargeOffAtMs: off,
    forceChargeOffLastAttemptMs: off, forceChargeOffEscalated: true, forceChargeOffDeadlinePagedAtMs: off + 30 * MIN,
  };
  const nextOpen = phx(2026, 11, 16, 23);
  const blind = (t: number, nextLegOpenMs: number | null | undefined) =>
    decideForceCharge({ ...s, forceChargeOffLastAttemptMs: t - FORCE_CHARGE_OFF_PERSIST_EVERY_MS }, t, fopts({ slotsOn: null, nextLegOpenMs }));
  assert.equal(blind(nextOpen - MIN, nextOpen).kind, 'offRetry');
  assert.equal(blind(nextOpen, nextOpen).kind, 'none', 'the next window may switch its own force-charge on');
  assert.equal(blind(nextOpen, null).kind, 'offRetry', 'unknown: the 12 h bound alone');
  assert.equal(blind(off + FORCE_CHARGE_BLIND_RESEND_MAX_MS, null).kind, 'none');
  assert.equal(blindResendStopMs(s, nextOpen), nextOpen);
  assert.equal(blindResendStopMs(s, null), off + FORCE_CHARGE_BLIND_RESEND_MAX_MS);
  // A next-window open at or before the first OFF is not a bound (a stale plan): the 12 h bound stands.
  assert.equal(blindResendStopMs(s, off), off + FORCE_CHARGE_BLIND_RESEND_MAX_MS);
  assert.equal(blindResendStopMs({ forceChargeOffAtMs: null }, nextOpen), null);
  // Overnight: the 05:00 OFF's 12 h bound (17:00) comes before the next 23:00 open — unchanged.
  const n = { ...s, forceChargeOffAtMs: NIGHT.endMs };
  assert.equal(blindResendStopMs(n, phx(2026, 10, 14, 23)), NIGHT.endMs + FORCE_CHARGE_BLIND_RESEND_MAX_MS);
});

/* ══ 3. revertDeadline ══ */

test('★★★ revertDeadline: an unconfirmed restore pages at close + 30 min overnight, and again at the on-peak start', () => {
  const s = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs };
  const deadline = NIGHT.endMs + REVERT_DEADLINE_AFTER_WINDOW_MS;
  assert.equal(revertDeadlineMs(s), deadline, '05:30: on-peak − 30 min is far later');
  assert.deepEqual(decideRevertDeadline(s, deadline - 1, null), { kind: 'none' });
  assert.deepEqual(decideRevertDeadline(s, deadline, null), { kind: 'page', stage: 'deadline', unknown: true });
  assert.deepEqual(decideRevertDeadline(s, deadline, 50), { kind: 'page', stage: 'deadline', unknown: false });
  const paged = { ...s, revertDeadlinePagedAtMs: deadline };
  assert.deepEqual(decideRevertDeadline(paged, deadline + HOUR, null), { kind: 'none' }, 'once');
  assert.deepEqual(decideRevertDeadline(paged, NIGHT_PEAK - 1, 50), { kind: 'none' });
  assert.deepEqual(decideRevertDeadline(paged, NIGHT_PEAK, 50), { kind: 'page', stage: 'onPeak', unknown: false });
  assert.deepEqual(decideRevertDeadline({ ...paged, revertDeadlineOnPeakPagedAtMs: NIGHT_PEAK }, NIGHT_PEAK + HOUR, 50), { kind: 'none' });
  // A process down through both: the on-peak page first (the integrator stamps both).
  assert.deepEqual(decideRevertDeadline(s, NIGHT_PEAK + MIN, null), { kind: 'page', stage: 'onPeak', unknown: true });
});

test('★★★ revertDeadline: min(close + 30, on-peak − 30) — 15:30 for a window closing at 15:00', () => {
  const s = applied(arm(MIDDAY));
  assert.equal(revertDeadlineMs(s), MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS);
  assert.equal(revertDeadlineMs(applied(arm(LATE))), MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS, 'the window close + 30 would be on-peak itself');
  // Applied, the restore never sent (its PUT kept failing): paged at 15:30 too.
  assert.deepEqual(decideRevertDeadline({ ...s, revertAttempts: 3 }, MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  // A record without the stamp: the close + 30 alone, and no on-peak page.
  const legacy = { ...applied(arm(NIGHT, false)), revertedAtMs: NIGHT.endMs };
  assert.equal(revertDeadlineMs(legacy), NIGHT.endMs + REVERT_DEADLINE_AFTER_WINDOW_MS);
  assert.deepEqual(decideRevertDeadline({ ...legacy, revertDeadlinePagedAtMs: NIGHT.endMs + 30 * MIN }, NIGHT_PEAK + HOUR, 50), { kind: 'none' });
  assert.equal(revertDeadlineMs({ windowEndMs: null, nextOnPeakStartMs: null }), null);
  assert.equal(revertDeadlineMs({ windowEndMs: null, nextOnPeakStartMs: MIDDAY_PEAK }), MIDDAY_PEAK - ON_PEAK_PAGE_LEAD_MS);
});

test('★★★ revertDeadline pages only on our target or no reading: any other value is the owner\'s', () => {
  const s = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs };
  const at = NIGHT.endMs + REVERT_DEADLINE_AFTER_WINDOW_MS;
  for (const owner of [10, 16, 20, 30, 49]) {
    // Decided at its moment, with no page: stamped as passed, never paged later.
    assert.deepEqual(decideRevertDeadline(s, at, owner), { kind: 'pass', stage: 'deadline', pct: owner }, `${owner}% is not ours`);
  }
  assert.deepEqual(decideRevertDeadline({ ...s, revertVerifiedAtMs: NIGHT.endMs + MIN }, at, 50), { kind: 'none' }, 'restored');
  assert.deepEqual(decideRevertDeadline({ ...s, foreignSettledAtMs: NIGHT.endMs + MIN }, at, 50), { kind: 'none' }, 'someone else\'s');
  assert.deepEqual(decideRevertDeadline(arm(NIGHT), at, null), { kind: 'none' }, 'nothing was written');
  assert.deepEqual(decideRevertDeadline({ ...arm(NIGHT), cancelled: true }, at, null), { kind: 'none' });
  assert.deepEqual(decideRevertDeadline(emptyActuationState(), at, null), { kind: 'none' });
  // An attempt never confirmed either way, with no reading: it may stand.
  const attempted = { ...arm(NIGHT), applyAttemptedAtMs: NIGHT.startMs, attemptBaselinePct: 16 };
  assert.deepEqual(decideRevertDeadline(attempted, at, null), { kind: 'page', stage: 'deadline', unknown: true });
  assert.deepEqual(decideRevertDeadline(attempted, at, 16), { kind: 'pass', stage: 'deadline', pct: 16 }, 'still the baseline: it never landed');
  assert.equal(revertOutstanding(attempted), true);
  assert.equal(revertOutstanding({ ...attempted, revertedAtMs: NIGHT.endMs }), false);
  assert.equal(restoreTargetPct(attempted), 16, 'the attempt baseline when no prior was read');
  assert.equal(restoreTargetPct({ priorReservePct: 7, attemptBaselinePct: null }), null);
});

test('★★ the spoken page: bilingual, our figures only, "could not confirm" when nothing is read, within the spoken bound', () => {
  for (const stage of ['deadline', 'onPeak'] as const) {
    for (const unknown of [true, false]) {
      const t = revertDeadlineSpoken({ stage, unknown, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM' });
      assert.ok(t.en.startsWith('Critical.'));
      assert.ok(t.es.startsWith('Alarma crítica. Alarma crítica.'), 'a bilingual second pass');
      assert.ok(t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${stage}/${unknown}: ${t.en.length + t.es.length} chars`);
      assert.match(t.en, /16 percent/);
      assert.match(t.es, /16 por ciento/);
      if (unknown) {
        assert.match(t.en, /confirm/);
        assert.doesNotMatch(t.en, /still reads/, 'no reading is never said to read raised');
      } else {
        assert.match(t.en, /still reads 50 percent/);
        assert.match(t.es, /sigue en el 50 por ciento/i);
      }
      assert.match(t.en, stage === 'onPeak' ? /On-peak pricing has started/ : /on-peak pricing starts at 4:00 PM/);
    }
  }
  const noStamp = revertDeadlineSpoken({ stage: 'deadline', unknown: false, targetPct: 50, restorePct: null, onPeakClock: null });
  assert.doesNotMatch(noStamp.en, /on-peak/);
  assert.match(noStamp.en, /its usual level/);
  const push = buildNightChargeRevertDeadline({ day: '2026-10-13', stage: 'deadline', unknown: true, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', retrying: true });
  assert.equal(push.severity, 'critical');
  assert.equal(push.dedupId, 'night_charge_revert_deadline');
  assert.match(push.body, /could not be confirmed/);
  assert.doesNotMatch(push.body, /still reads/);
  assert.match(push.body, /On-peak pricing starts at 4:00 PM/);
  const stuck = buildNightChargeRevertDeadline({ day: '2026-10-13', stage: 'onPeak', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', retrying: true });
  assert.match(stuck.title, /still raised/);
  assert.match(stuck.body, /still reads 50%/);
  assert.match(stuck.body, /started at 4:00 PM/);
});

/* ══ 4. the foreign rule ══ */

test('★★★ foreign: one reading records, the same value five minutes later settles — and the restore is never sent', () => {
  const s = applied(arm(NIGHT));
  const t1 = NIGHT.startMs + 2 * HOUR;
  assert.deepEqual(decideActuation(s, t1, ropts({ currentReservePct: 30 })), { kind: 'foreignSeen', pct: 30 });
  const seen = { ...s, foreignReservePct: 30, foreignSeenAtMs: t1 };
  assert.equal(decideActuation(seen, t1 + 2 * MIN, ropts({ currentReservePct: 30 })).kind, 'none', 'pending');
  assert.equal(decideActuation(seen, t1 + FOREIGN_RESERVE_SETTLE_MS - 1, ropts({ currentReservePct: 30 })).kind, 'none');
  assert.deepEqual(decideActuation(seen, t1 + FOREIGN_RESERVE_SETTLE_MS, ropts({ currentReservePct: 30 })), { kind: 'foreignSettled', pct: 30 });
  const settled = { ...seen, foreignSettledAtMs: t1 + FOREIGN_RESERVE_SETTLE_MS };
  // Nothing more is written: not at the close, not on a cancel, not on a grid loss.
  assert.equal(decideActuation(settled, NIGHT.endMs, ropts({ currentReservePct: 30 })).kind, 'none');
  assert.equal(decideActuation({ ...settled, cancelled: true }, NIGHT.endMs, ropts({ currentReservePct: 30 })).kind, 'none');
  assert.equal(decideActuation(settled, NIGHT.endMs, ropts({ currentReservePct: 30, gridPresent: false })).kind, 'none');
  // Without the rule the close would restore 16 over the owner's 30.
  assert.deepEqual(decideActuation(seen, NIGHT.endMs, ropts({ currentReservePct: 30 })), { kind: 'foreignSettled', pct: 30 });
});

test('★★★ foreign needs two readings of the same in-envelope value: null, out-of-envelope and our own values never settle it', () => {
  const s = applied(arm(NIGHT));
  const t1 = NIGHT.startMs + 2 * HOUR;
  const seen = { ...s, foreignReservePct: 30, foreignSeenAtMs: t1 };
  const later = t1 + FOREIGN_RESERVE_SETTLE_MS;
  assert.deepEqual(foreignStep(seen, 35, later), { kind: 'foreignSeen', pct: 35 }, 'a different value restarts it');
  assert.equal(foreignStep(seen, null, later), null, 'no reading: nothing either way');
  assert.equal(foreignStep(s, null, later), null, 'never foreign on null');
  for (const v of [0, 9, 51, 100, 30.5]) assert.equal(isForeignReserveReading(s, v), false, `${v} is not a setting`);
  assert.deepEqual(foreignStep(seen, 50, later), { kind: 'foreignCleared' }, 'our target again');
  assert.deepEqual(foreignStep(seen, 16, later), { kind: 'foreignCleared' }, 'our prior again');
  assert.equal(foreignStep(s, 50, later), null, 'nothing pending: nothing to clear');
  assert.equal(isForeignReserveReading({ targetPct: 50, priorReservePct: null }, 30), false, 'no valid prior: ours and theirs cannot be told apart');
  // An out-of-envelope reading at the close: the restore goes, blind, as before.
  assert.deepEqual(decideActuation(s, NIGHT.endMs, ropts({ currentReservePct: 0 })), { kind: 'revert', restorePct: 16 });
  assert.deepEqual(decideActuation(s, NIGHT.endMs, ropts({ currentReservePct: null })), { kind: 'revert', restorePct: 16 });
  // A sighting still pending at the close does not hold the restore: it stays clock-driven — and
  // neither does a first sighting on the closing tick itself.
  assert.deepEqual(decideActuation({ ...seen, foreignSeenAtMs: NIGHT.endMs - MIN }, NIGHT.endMs, ropts({ currentReservePct: 30 })), { kind: 'revert', restorePct: 16 });
  assert.deepEqual(decideActuation(s, NIGHT.endMs, ropts({ currentReservePct: 30 })), { kind: 'revert', restorePct: 16 });
  // Before the write reads back, a short reading is the apply ladder's (deviceCeilingPct), not foreign.
  const unverified = { ...s, applyVerifiedAtMs: null };
  assert.notEqual(decideActuation(unverified, NIGHT.startMs + APPLY_VERIFY_AFTER_MS, ropts({ currentReservePct: 30 })).kind, 'foreignSeen');
});

test('★★ foreign after the restore was sent: the wait for its readback ends, with no re-issue', () => {
  const s = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs };
  assert.deepEqual(decideActuation(s, NIGHT.endMs + 2 * MIN, ropts({ currentReservePct: 40 })), { kind: 'foreignSeen', pct: 40 });
  const seen = { ...s, foreignReservePct: 40, foreignSeenAtMs: NIGHT.endMs + 2 * MIN };
  assert.deepEqual(decideActuation(seen, NIGHT.endMs + 7 * MIN, ropts({ currentReservePct: 40 })), { kind: 'foreignSettled', pct: 40 });
  const settled = { ...seen, foreignSettledAtMs: NIGHT.endMs + 7 * MIN };
  assert.equal(decideActuation(settled, NIGHT.endMs + HOUR, ropts({ currentReservePct: 50 })).kind, 'none', 'no retry, no failure page');
});

test('★★★ a settled foreign reserve resolves the night: the next arm proceeds, and nothing reads it as raised by us', () => {
  const settled = { ...applied(arm(NIGHT)), foreignReservePct: 30, foreignSeenAtMs: NIGHT.startMs + HOUR, foreignSettledAtMs: NIGHT.startMs + HOUR + 5 * MIN };
  const tomorrow = { startMs: NIGHT.startMs + 24 * HOUR, endMs: NIGHT.endMs + 24 * HOUR };
  assert.ok(armFromPlan(settled, '2026-10-14', plan(tomorrow), tomorrow.startMs - 90 * MIN, 30, true, NIGHT_PEAK + 24 * HOUR));
  assert.equal(armRefusalReason(settled, plan(tomorrow), tomorrow.startMs - 90 * MIN, 30), null);
  assert.equal(isReserveArbitrageRaised(settled), false);
  assert.equal(ownerReserveFloorPct(settled, 30, NIGHT.startMs + 2 * HOUR), 30, 'the owner\'s value is the floor');
  // Unsettled, the applied write still refuses — unchanged.
  const unsettled = applied(arm(NIGHT));
  assert.equal(armFromPlan(unsettled, '2026-10-14', plan(tomorrow), tomorrow.startMs - 90 * MIN, 50), null);
  assert.match(armRefusalReason(unsettled, plan(tomorrow), tomorrow.startMs - 90 * MIN, 50) ?? '', /still applied/);
  assert.equal(isReserveArbitrageRaised(unsettled), true);
  // The info push: the value, ours, and that nothing more is written.
  const push = buildNightChargeForeignReserve({ day: '2026-10-13', pct: 30, targetPct: 50, restorePct: 16 });
  assert.equal(push.severity, 'info');
  assert.match(push.title, /30%/);
  assert.match(push.body, /not the 50%.*nor the 16%/);
  assert.match(push.body, /writes nothing/);
});

test('★★ a settled foreign reserve switches our force-charge OFF and never starts one', () => {
  const settled = { ...applied(arm(NIGHT)), foreignReservePct: 30, foreignSettledAtMs: NIGHT.startMs + HOUR };
  const on = { ...settled, forceChargeOnAtMs: NIGHT.startMs + 30 * MIN, forceChargeSlots: [1, 2] };
  assert.deepEqual(decideForceCharge(on, NIGHT.startMs + 2 * HOUR, fopts({ slotsOn: [1, 2] })), { kind: 'off', slots: [1, 2], reason: 'foreign' });
  assert.equal(forceChargeOffDueNow(on, NIGHT.startMs + 2 * HOUR), true);
  const start = decideForceCharge(settled, NIGHT.endMs - HOUR, fopts());
  assert.equal(start.kind, 'none');
  assert.match((start as { why?: string }).why ?? '', /outside the add-on/);
});

/* ══ 5. heldByChargeWrite: the money detectors ══ */

test('★★★ heldByChargeWrite: past the restore, with the panel still reading our target, the money detectors use the prior floor', () => {
  const stuck = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs };
  const hold = chargeWriteHold(stuck);
  assert.deepEqual(hold, { targetPct: 50, priorPct: 16, restoreDueMs: NIGHT.endMs, heldFromMs: NIGHT.endMs + REVERT_VERIFY_AFTER_MS });
  assert.deepEqual(moneyDetectorReservePct(50, hold, NIGHT_PEAK), { reservePct: 16, heldByChargeWrite: true });
  assert.deepEqual(moneyDetectorReservePct(50, hold, NIGHT.endMs - 1), { reservePct: 50, heldByChargeWrite: false }, 'inside the window it is ours by design');
  assert.deepEqual(moneyDetectorReservePct(50, hold, NIGHT.endMs + REVERT_VERIFY_AFTER_MS - 1), { reservePct: 50, heldByChargeWrite: false }, 'inside the restore\'s readback grace it has not failed');
  assert.deepEqual(moneyDetectorReservePct(50, hold, NIGHT.endMs + REVERT_VERIFY_AFTER_MS), { reservePct: 16, heldByChargeWrite: true });
  assert.deepEqual(moneyDetectorReservePct(30, hold, NIGHT_PEAK), { reservePct: 30, heldByChargeWrite: false }, 'another value is the panel\'s');
  assert.deepEqual(moneyDetectorReservePct(null, hold, NIGHT_PEAK), { reservePct: null, heldByChargeWrite: false });
  assert.deepEqual(moneyDetectorReservePct(50, null, NIGHT_PEAK), { reservePct: 50, heldByChargeWrite: false });
  assert.equal(chargeWriteHold({ ...stuck, revertVerifiedAtMs: NIGHT.endMs + MIN }), null, 'restored');
  assert.equal(chargeWriteHold({ ...stuck, foreignSettledAtMs: NIGHT.endMs + MIN }), null, 'someone else\'s');
  assert.equal(chargeWriteHold(arm(NIGHT)), null, 'never applied');
  assert.equal(chargeWriteHold({ ...stuck, priorReservePct: 50 }), null, 'nothing raised');
  // The restore never sent at all (its PUT kept failing): held the same way, from the due moment's grace.
  assert.deepEqual(chargeWriteHold(applied(arm(NIGHT))), { targetPct: 50, priorPct: 16, restoreDueMs: NIGHT.endMs, heldFromMs: NIGHT.endMs + REVERT_VERIFY_AFTER_MS });
  // The runway and below-reserve alarms are untouched: past the settling grace they read the live 50.
  assert.equal(ownerReserveFloorPct(stuck, 50, NIGHT.endMs + REVERT_READBACK_GRACE_MS + 1), 50);
});

test('★★★ the grid-to-battery detector fires on a stuck restore it used to read as "near the reserve"', () => {
  // Wed 16:30: on-peak, the pool at 45% refilling to the night's stuck 50% from the grid.
  const at = NIGHT_PEAK + 30 * MIN;
  const base: PeakDrawInputs = {
    nowMs: at, gridImportW: 9000, panelLoadW: 2000, pvW: 0, socPct: 45, reserveSocPct: 50, gridPresent: true,
    coreDraws: [{ label: 'Core 1', acInWatts: 7000 }], onsetMs: at - 15 * MIN,
  };
  assert.equal(assessPeakDraw(base, REV, DEFAULT_PEAK_DRAW_CONFIG).suppressed, 'below-reserve', 'the live 50 silenced it');
  const r = moneyDetectorReservePct(50, chargeWriteHold({ ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs }), at);
  const v = assessPeakDraw({ ...base, reserveSocPct: r.reservePct, heldByChargeWrite: r.heldByChargeWrite, panelReserveSocPct: 50 }, REV, DEFAULT_PEAK_DRAW_CONFIG);
  assert.equal(v.active, true);
  assert.deepEqual(v.heldByChargeWrite, { panelReservePct: 50, floorPct: 16 });
  const [a] = peakGridDrawAlerts(v, at);
  assert.match(a.detail, /still reads 50%: the night charge's restore to 16% has not taken effect/);
  assert.match(a.detail, /Set the backup reserve to 16%/);
  assert.equal(a.priority, 'low', 'still money, never danger');
  // Not held: the verdict is the shape it always was.
  assert.equal('heldByChargeWrite' in assessPeakDraw({ ...base, reserveSocPct: 10 }, REV, DEFAULT_PEAK_DRAW_CONFIG), false);
});

test('★★★ the idle-pool detector, from the house panel\'s readings, measures past a stuck restore', () => {
  const at = NIGHT_PEAK + 30 * MIN;
  const devices = {
    'SHP2-A': {
      sn: 'SHP2-A', deviceName: 'Smart Home Panel 2', online: true, lastUpdated: at - 30_000,
      projection: {
        kind: 'shp2', gridWatt: 1500, backupBatPercent: 54, backupFullCapWh: 92_160,
        sourceWatts: [0, 0, 0], strategy: { backupReserveSoc: 50, smartBackupMode: 2 }, sources: [], pairedCircuits: [],
      },
    },
  } as any;
  const hold = chargeWriteHold({ ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs });
  const plain = idlePoolInputsFrom(devices, true, at);
  assert.equal(plain.reserveSocPct, 50);
  assert.equal('heldByChargeWrite' in plain, false, 'no hold: the inputs are the shape they always were');
  assert.equal(classifyIdlePool(plain, REV).suppressed, 'near-reserve');
  const held = idlePoolInputsFrom(devices, true, at, null, hold);
  assert.equal(held.reserveSocPct, 16);
  assert.equal(held.heldByChargeWrite, true);
  assert.equal(held.panelReserveSocPct, 50);
  assert.equal(classifyIdlePool(held, REV).suppressed, null);
  for (let m = 0; m <= IDLE_DWELL_MS / MIN; m++) evaluateIdlePool({ ...held, nowMs: at + m * MIN }, REV);
  const v = evaluateIdlePool({ ...held, nowMs: at + IDLE_DWELL_MS + MIN }, REV);
  assert.equal(v.active, true);
  const [a] = peakIdlePoolAlerts(v, at + IDLE_DWELL_MS + MIN);
  assert.match(a.detail, /night charge's restore to 16% has not taken effect/);
  assert.ok(a.facts?.some((f) => f.label === 'Reserve' && /panel reads 50%/.test(f.value)));
  // Before the restore was due the hold is not applied.
  assert.equal(idlePoolInputsFrom(devices, true, NIGHT.endMs - MIN, null, hold).reserveSocPct, 50);
});

/* ══ 7. /api/reserve-floor names the restore time ══ */

test('★★ the reserve-floor refusal names when the night\'s write restores — or that it is overdue', () => {
  const fmt = (ms: number) => `at ${new Date(ms).toISOString().slice(11, 16)}Z`;
  const s = applied(arm(NIGHT));
  const before = reserveRestoreNote(s, NIGHT.startMs + HOUR, fmt);
  assert.equal(before.atMs, NIGHT.endMs);
  assert.match(before.text, /^it restores 16% at 12:00Z, and would put that back over a floor set now$/);
  const late = reserveRestoreNote(applied(arm(LATE)), LATE.startMs + 10 * MIN, fmt);
  assert.equal(late.atMs, phx(2026, 11, 16, 15), 'the guard, not the 17:00 close');
  const overdue = reserveRestoreNote(s, NIGHT.endMs + HOUR, fmt);
  assert.match(overdue.text, /was due at 12:00Z and has not completed yet/);
  assert.match(reserveRestoreNote({ ...s, cancelled: true }, NIGHT.startMs + HOUR, fmt).text, /cancelled.*within a minute/);
  assert.equal(reserveRestoreNote({ ...s, windowEndMs: null, nextOnPeakStartMs: null }, NIGHT.startMs, fmt).atMs, null);
});

/* ══ wiring (index.ts and the alert monitor are not reachable from a unit test) ══ */

const SRC = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src', f), 'utf8');

test('★★★ index.ts: the arm stamps the on-peak start from the plan\'s window, from the tariff model the window comes from', () => {
  const idx = SRC('index.ts');
  assert.ok(idx.includes('const armOnPeakStartMs = plan.window != null ? nextOnPeakStartMs(apsREvModelFromEnv(), plan.window.startMs) : null;'));
  // v1.189.0 — armed through armCycle (chargeCycle.ts), the stamp on the leg.
  assert.ok(idx.includes("role: 'cost', kind: 'overnight', plan, forceChargeEnabled: forceChargeOn(), nextOnPeakStartMs: armOnPeakStartMs,"));
});

test('★★★ index.ts: revertDeadline is decided ahead of the reserve decision and of the no-panel return, and stamped before it speaks', () => {
  const idx = SRC('index.ts');
  const fn = idx.indexOf('async function runNightActuationTickInner(');
  const body = idx.slice(fn, idx.indexOf('\nif (nightChargeEnabled) {', fn));
  const page = body.indexOf('const revertPage = decideRevertDeadline(state, nowMs, currentReservePct, shp2 != null);');
  assert.ok(page > 0);
  assert.ok(page < body.indexOf('const action = decideActuation(state, nowMs, {'));
  assert.ok(page < body.indexOf("if (action.kind === 'none' || !shp2) return;"));
  assert.ok(body.includes("if (revertPage.kind === 'page') {\n    pageRevertDeadline(state, revertPage, nowMs, revertRetryPending(state, currentReservePct, shp2 != null));"));
  // A stage decided with no page is stamped as passed — it is never paged later.
  assert.ok(body.includes("} else if (revertPage.kind === 'pass') {\n    persistNightActuation(revertPage.stage === 'onPeak'\n      ? { ...state, revertDeadlineOnPeakPassedAtMs: nowMs }\n      : { ...state, revertDeadlinePassedAtMs: nowMs });"));
  // A never-landed attempt is proven on a live reading, ahead of the page.
  const proof = body.indexOf('if (attemptProvedUnlanded(state, currentReservePct, nowMs)) {\n    persistNightActuation({ ...state, attemptUnlandedAtMs: nowMs });');
  assert.ok(proof > 0 && proof < page, 'the proof is stamped before the page is decided');
  // So is the proof for an ACK'd write that never took effect.
  const applied2 = body.indexOf('if (applyProvedUnlanded(state, currentReservePct, nowMs)) {\n    persistNightActuation({ ...state, applyUnlandedAtMs: nowMs });');
  assert.ok(applied2 > proof && applied2 < page, 'the applied-write proof too');
  // A deadline that waits for its restore is stamped on its first tick — the wait's bound runs from it.
  assert.ok(body.includes("if (revertPage.kind === 'hold') {\n    if (state.revertDeadlineHeldAtMs == null) {\n      persistNightActuation({ ...state, revertDeadlineHeldAtMs: nowMs });"));
  assert.ok(body.includes('state = nightActuationMem; // the stamp is on the record every write below spreads'));
  const pg = idx.slice(idx.indexOf('function pageRevertDeadline('), fn);
  assert.ok(pg.indexOf('persistNightActuation({') < pg.indexOf("broadcast.announce('critical', spoken.en, spoken.es)"), 'stamped first');
  assert.ok(pg.includes('revertDeadlinePagedAtMs: state.revertDeadlinePagedAtMs ?? nowMs,'));
  assert.ok(pg.includes("revertDeadlineOnPeakPagedAtMs: d.stage === 'onPeak' ? nowMs : state.revertDeadlineOnPeakPagedAtMs,"));
  assert.ok(pg.includes('buildNightChargeRevertDeadline({'));
  assert.ok(pg.includes('void (async () => {'), 'never holds the tick');
});

test('★★ index.ts: the foreign decisions are recorded, and the settle pushes', () => {
  const idx = SRC('index.ts');
  // A partly granted write the panel moved within its request is adopted as the target, and the
  // pending sighting it ends is cleared (nightChargeActuator.ceilingMovedPct).
  const moved = idx.slice(idx.indexOf("if (action.kind === 'ceilingMoved') {"), idx.indexOf("if (action.kind === 'retryApply') {"));
  assert.ok(moved.length > 0 && moved.length < 2000, 'the ceilingMoved handler is found');
  assert.ok(moved.includes('persistNightActuation({ ...state, targetPct: action.pct, foreignReservePct: null, foreignSeenAtMs: null, lastError: null });'));
  assert.ok(moved.includes('return;'));
  assert.ok(idx.includes("persistNightActuation({ ...state, foreignReservePct: action.pct, foreignSeenAtMs: nowMs });"));
  assert.ok(idx.includes("persistNightActuation({ ...state, foreignReservePct: null, foreignSeenAtMs: null });"));
  assert.ok(idx.includes("persistNightActuation({ ...state, foreignSettledAtMs: nowMs, foreignReservePct: action.pct, lastError: null });"));
  assert.ok(idx.includes('void sendNotification(loadNotifyConfig(), buildNightChargeForeignReserve({'));
  // A settled night has nothing left to cancel, and its owner's later reserve moves are external again.
  // v1.189.0 — the cancel is decided per leg (chargeCycle.cancelLeg), and so is the drift attribution
  // (chargeCycle.legDriftActive; the overnight leg keeps this rule).
  const cyc = SRC('chargeCycle.ts');
  assert.ok(cyc.includes("if (s.foreignSettledAtMs != null) {\n    return { ok: false, error: `the reserve was set to"));
  assert.ok(cyc.includes('return (leg.appliedAtMs != null && leg.revertedAtMs == null && leg.foreignSettledAtMs == null) ||'));
});

test('★★ index.ts: the write hold is published with every record, the next window bounds blind re-sends, and the refusal names the restore', () => {
  const idx = SRC('index.ts');
  const persist = idx.slice(idx.indexOf('function persistNightActuation('), idx.indexOf('atomicWriteFileSync(NIGHT_CHARGE_ACTUATION_PATH', idx.indexOf('function persistNightActuation(')));
  assert.ok(persist.includes('setChargeWriteHold(chargeWriteHold(s));'));
  assert.ok(idx.includes('setChargeWriteHold(chargeWriteHold(nightActuationMem));'), 'and at boot, from the persisted record');
  // v1.189.0 — the next cost leg pending in the cycle, else the latest plan's window (chargeCycle.nextForceChargeOpenMs).
  assert.ok(idx.includes('nextLegOpenMs: nextForceChargeOpenMs(state, nightCyclePending, fcPlan?.window?.startMs),'));
  assert.ok(idx.includes('const restore = reserveRestoreNote(nightActuationMem, Date.now(), fmtDeadlineSpoken);'));
  assert.ok(idx.includes('error: `a night-charge write is currently holding the reserve up; ${restore.text}`,'));
  assert.ok(idx.includes('restoreAtMs: restore.atMs,'));
});

test('★★★ the alert monitor: both money detectors read the reserve through the write hold', () => {
  const m = SRC('alertMonitor.ts');
  assert.ok(m.includes('const chargeHold = getChargeWriteHold();'));
  assert.ok(m.includes('const peakReserve = moneyDetectorReservePct(peakShp2?.projection.strategy?.backupReserveSoc ?? null, chargeHold, Date.now());'));
  assert.ok(m.includes('reserveSocPct: peakReserve.reservePct,'));
  assert.ok(m.includes('idlePoolInputsFrom(snap.devices, grid.present, idleNowMs, forecastNow, chargeHold)'));
  assert.ok(m.includes('const reserve = moneyDetectorReservePct(p?.strategy?.backupReserveSoc ?? null, chargeHold ?? null, nowMs);'));
});

/* ══ the failure paths, reviewed: a night that goes to plan says nothing, a failure says only what is true ══ */


/**
 * One applied night's close, tick by tick: the actuator ticks every 60 s (`tickOffsetMs` into each
 * minute), the alert monitor evaluates every 20 s, and the panel reads the restored 16% `lagMs`
 * after the restore's ACK when the restore takes. `rejectUntilMs`: the cloud rejects every restore
 * PUT before it. Returns the record and the evaluations that read heldByChargeWrite.
 */
function simulateClose(o: { tickOffsetMs: number; lagMs: number; takes: boolean; rejectUntilMs?: number; untilMs?: number }) {
  let s = applied(arm(NIGHT));
  const until = o.untilMs ?? NIGHT.endMs + 40 * MIN;
  const reading = (t: number): number =>
    o.takes && s.revertedAtMs != null && t >= s.revertedAtMs + o.lagMs ? 16 : 50;
  const events: Array<{ t: number; k: 'tick' | 'eval' }> = [];
  for (let t = NIGHT.endMs - MIN + o.tickOffsetMs; t <= until; t += MIN) events.push({ t, k: 'tick' });
  for (let t = NIGHT.endMs - MIN + 3_000; t <= until; t += 20_000) events.push({ t, k: 'eval' });
  events.sort((a, b) => a.t - b.t || (a.k === 'tick' ? -1 : 1));
  const held: number[] = [];
  for (const e of events) {
    if (e.k === 'eval') {
      if (moneyDetectorReservePct(reading(e.t), chargeWriteHold(s), e.t).heldByChargeWrite) held.push(e.t);
      continue;
    }
    const a = decideActuation(s, e.t, ropts({ currentReservePct: reading(e.t) }));
    if (a.kind === 'revert') {
      if (o.rejectUntilMs == null || e.t >= o.rejectUntilMs) s = { ...s, revertedAtMs: e.t };
      else s = { ...s, revertAttempts: s.revertAttempts + 1 };
    } else if (a.kind === 'revertVerified') s = { ...s, revertVerifiedAtMs: e.t };
    else if (a.kind === 'retryRevert') s = { ...s, revertRetries: s.revertRetries + 1, revertLastAttemptMs: e.t };
    else if (a.kind === 'revertFailed') s = { ...s, revertReadbackEscalated: true };
  }
  return { s, held };
}

test('★★★ heldByChargeWrite: a 05:00 restore that goes to plan never engages it — not inside its readback lag', () => {
  // The restore is sent on the first tick after 05:00 and the panel echoes 50% until the readback
  // lands: held from the due moment, almost every armed night logged "heldByChargeWrite — … past its
  // restore" and then "cleared" about a restore that was fine.
  for (const tickOffsetMs of [1_000, 23_000, 37_000, 59_000]) {
    for (const lagMs of [20_000, 40_000, 60_000, 90_000, 4 * MIN]) {
      const r = simulateClose({ tickOffsetMs, lagMs, takes: true });
      assert.deepEqual(r.held, [], `tick +${tickOffsetMs / 1000}s, readback ${lagMs / 1000}s: never held`);
      assert.ok(r.s.revertVerifiedAtMs != null, 'and the restore read back');
    }
  }
  // A restore the cloud accepted late (rejected for three minutes) that then reads back: never held.
  const late = simulateClose({ tickOffsetMs: 37_000, lagMs: 60_000, takes: true, rejectUntilMs: NIGHT.endMs + 3 * MIN });
  assert.deepEqual(late.held, []);
});

test('★★★ heldByChargeWrite: a stuck restore engages it once its readback grace has run, and it never lapses through the re-issues', () => {
  const stuck = simulateClose({ tickOffsetMs: 37_000, lagMs: 0, takes: false });
  const sent = NIGHT.endMs + 37_000;
  assert.equal(stuck.s.revertReadbackEscalated, true, 'the re-issues are spent');
  assert.ok(stuck.held.length > 0);
  assert.ok(stuck.held[0] >= sent + REVERT_VERIFY_AFTER_MS && stuck.held[0] < sent + REVERT_VERIFY_AFTER_MS + 20_000, 'from the ACK + the readback grace');
  // Continuous from then on: every evaluation after the first held one is held too.
  const first = stuck.held[0];
  const evals = Math.floor((NIGHT.endMs + 40 * MIN - first) / 20_000) + 1;
  assert.equal(stuck.held.length, evals, 'no lapse while the re-issues go out');
  // Restores rejected for ten minutes, then one accepted that does not take: held from the due
  // moment's grace, and the late ACK does not lapse it for a fresh grace.
  const rejected = simulateClose({ tickOffsetMs: 37_000, lagMs: 0, takes: false, rejectUntilMs: NIGHT.endMs + 10 * MIN });
  assert.ok(rejected.held[0] >= NIGHT.endMs + REVERT_VERIFY_AFTER_MS && rejected.held[0] < NIGHT.endMs + REVERT_VERIFY_AFTER_MS + 20_000);
  assert.equal(rejected.held.length, Math.floor((NIGHT.endMs + 40 * MIN - rejected.held[0]) / 20_000) + 1, 'continuous across the late ACK');
  // The rule itself.
  const due = NIGHT.endMs;
  assert.equal(chargeWriteHeldFromMs(due, null), due + REVERT_VERIFY_AFTER_MS, 'nothing accepted yet: the due moment\'s grace');
  assert.equal(chargeWriteHeldFromMs(due, due + 37_000), due + 37_000 + REVERT_VERIFY_AFTER_MS, 'the ACK\'s own grace');
  assert.equal(chargeWriteHeldFromMs(due, due - 6 * HOUR), due + REVERT_VERIFY_AFTER_MS, 'a cancel\'s early restore: from the due moment');
  assert.equal(chargeWriteHeldFromMs(due, due + 10 * MIN), due + REVERT_VERIFY_AFTER_MS, 'an ACK after the hold applied does not move it');
});

test('★★★ revertDeadline: a write the cloud rejected all night pages nothing — not at the deadline, not on a stale reading hours or days later', () => {
  // Every apply PUT in the window rejected (the attempt recorded each time, baseline 16); the panel
  // reads 16 except on the stale ticks listed. Three days of minute ticks, as the integrator runs them.
  const stale = new Set([phx(2026, 10, 14, 10, 7), phx(2026, 10, 14, 16, 0), phx(2026, 10, 14, 16, 5), phx(2026, 10, 16, 9, 0)]);
  let s = arm(NIGHT);
  let pages = 0;
  for (let t = NIGHT.startMs; t <= NIGHT.startMs + 3 * 24 * HOUR; t += MIN) {
    const reading = stale.has(t) ? null : 16;
    if (attemptProvedUnlanded(s, reading, t)) s = { ...s, attemptUnlandedAtMs: t };
    const d = decideRevertDeadline(s, t, reading);
    if (d.kind === 'page') pages++;
    if (d.kind === 'pass') s = d.stage === 'onPeak' ? { ...s, revertDeadlineOnPeakPassedAtMs: t } : { ...s, revertDeadlinePassedAtMs: t };
    const a = decideActuation(s, t, ropts({ currentReservePct: reading }));
    if (a.kind === 'apply') s = { ...s, applyAttemptedAtMs: t, attemptBaselinePct: reading };
  }
  assert.equal(pages, 0, 'nothing of ours was ever on the panel');
  assert.ok(s.attemptUnlandedAtMs != null && s.attemptUnlandedAtMs > NIGHT.startMs + APPLY_LATE_MS, 'proven never landed, after the apply window');
  assert.equal(revertOutstanding(s), false);
  assert.equal(armOpenItem(s, null), null, 'the next evening arms even on a stale reading');
  assert.equal(attemptNeverLanded(s, null), true);
});

test('★★★ attemptProvedUnlanded: only a live baseline reading, once the apply ladder is over and the last attempt\'s readback grace has run', () => {
  const lastTry = NIGHT.startMs + 29 * MIN;
  const s = { ...arm(NIGHT), applyAttemptedAtMs: lastTry, attemptBaselinePct: 16 };
  assert.equal(attemptProvedUnlanded(s, 16, NIGHT.startMs + 20 * MIN), false, 'the apply window is still open');
  // An attempt made at the open, past its readback grace, but with the apply window still open: a
  // re-attempt may still come, so nothing is proven yet.
  const early = { ...s, applyAttemptedAtMs: NIGHT.startMs };
  assert.equal(attemptProvedUnlanded(early, 16, NIGHT.startMs + 10 * MIN), false, 'the apply ladder is not over');
  assert.equal(attemptProvedUnlanded(early, 16, NIGHT.startMs + APPLY_LATE_MS + 1), true);
  assert.equal(attemptProvedUnlanded(s, 16, NIGHT.startMs + APPLY_LATE_MS + 1), false, 'the last attempt is still inside its readback grace');
  assert.equal(attemptProvedUnlanded(s, 16, lastTry + APPLY_VERIFY_AFTER_MS), true);
  assert.equal(attemptProvedUnlanded(s, null, lastTry + HOUR), false, 'no reading proves nothing');
  assert.equal(attemptProvedUnlanded(s, 50, lastTry + HOUR), false, 'our target: it landed (ADOPT takes it)');
  assert.equal(attemptProvedUnlanded(s, 30, lastTry + HOUR), false, 'another value is not the baseline');
  assert.equal(attemptProvedUnlanded({ ...s, attemptUnlandedAtMs: lastTry + 10 * MIN }, 16, lastTry + HOUR), false, 'stamped once');
  assert.equal(attemptProvedUnlanded({ ...s, appliedAtMs: lastTry }, 16, lastTry + HOUR), false, 'a success was recorded');
  const cancelled = { ...s, applyAttemptedAtMs: NIGHT.startMs, cancelled: true };
  assert.equal(attemptProvedUnlanded(cancelled, 16, NIGHT.startMs + APPLY_VERIFY_AFTER_MS), true, 'a cancel ends the ladder too');
  // Proven, a later adoption still takes it: the write that landed after all is outstanding again.
  const proven = { ...s, attemptUnlandedAtMs: lastTry + 10 * MIN };
  assert.deepEqual(decideActuation(proven, lastTry + HOUR, ropts({ currentReservePct: 50 })), { kind: 'adopt', priorPct: 16 });
  assert.equal(revertOutstanding({ ...proven, appliedAtMs: lastTry }), true);
});

test('★★★ revertDeadline: each stage is decided once, at its moment, and a stage past its span is dropped', () => {
  const s = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs };
  const deadline = revertDeadlineMs(s)!;
  // Passed at the deadline on the restored value: a stale reading later in the day pages nothing.
  const passed = { ...s, revertDeadlinePassedAtMs: deadline };
  assert.deepEqual(decideRevertDeadline(passed, deadline + 8 * HOUR, null), { kind: 'none' });
  assert.equal(revertDeadlineStageDue(passed, deadline + HOUR), null);
  // The on-peak stage is its own moment: a stuck reading then still pages.
  assert.deepEqual(decideRevertDeadline(passed, NIGHT_PEAK, 50), { kind: 'page', stage: 'onPeak', unknown: false });
  assert.deepEqual(decideRevertDeadline({ ...passed, revertDeadlineOnPeakPassedAtMs: NIGHT_PEAK }, NIGHT_PEAK + HOUR, null), { kind: 'none' });
  // The spans: the deadline stage until the on-peak start; the on-peak stage for its period.
  assert.equal(revertDeadlineStageDue(s, NIGHT_PEAK - 1), 'deadline', 'a process back before on-peak still decides the deadline stage');
  assert.equal(revertDeadlineStageDue(s, NIGHT_PEAK), 'onPeak');
  assert.equal(revertDeadlineStageDue(s, NIGHT_PEAK + REVERT_PAGE_STAGE_SPAN_MS - 1), 'onPeak');
  assert.equal(revertDeadlineStageDue(s, NIGHT_PEAK + REVERT_PAGE_STAGE_SPAN_MS), null, 'the on-peak period is over');
  assert.deepEqual(decideRevertDeadline(s, NIGHT_PEAK + 7 * 24 * HOUR, null), { kind: 'none' }, 'a week later: nothing');
  // No on-peak stamp: the deadline stage alone, for its span.
  const legacy = { ...applied(arm(NIGHT, false)), revertedAtMs: NIGHT.endMs };
  const d = revertDeadlineMs(legacy)!;
  assert.equal(revertDeadlineStageDue(legacy, d + REVERT_PAGE_STAGE_SPAN_MS - 1), 'deadline');
  assert.equal(revertDeadlineStageDue(legacy, d + REVERT_PAGE_STAGE_SPAN_MS), null);
  assert.equal(REVERT_PAGE_STAGE_SPAN_MS, 3 * HOUR, 'the R-EV on-peak period');
});

test('★★★ revertRetryPending: the page says the restore is retried only while one will still be sent', () => {
  const ap = applied(arm(NIGHT));
  assert.equal(revertRetryPending(ap, null, true), true, 'not accepted yet: re-sent every tick, blind');
  assert.equal(revertRetryPending({ ...ap, priorReservePct: 7 }, 50, true), false, 'no valid value to restore: nothing is sent');
  assert.equal(revertRetryPending(ap, 50, false), false, 'the panel is not in the device list: nothing is sent');
  const acked = { ...ap, revertedAtMs: NIGHT.endMs };
  assert.equal(revertRetryPending(acked, 50, true), true, 'accepted, still raised, re-issues left');
  assert.equal(revertRetryPending({ ...acked, revertRetries: REVERT_MAX_RETRIES }, 50, true), false, 'the re-issues are spent');
  assert.equal(revertRetryPending({ ...acked, revertReadbackEscalated: true }, 50, true), false);
  assert.equal(revertRetryPending(acked, null, true), false, 'no reading: a re-issue needs our target read back');
  assert.equal(revertRetryPending({ ...acked, revertVerifiedAtMs: NIGHT.endMs + MIN }, 50, true), false);
  assert.equal(revertRetryPending({ ...acked, foreignSettledAtMs: NIGHT.endMs + MIN }, 50, true), false);
  const attempted = { ...arm(NIGHT), applyAttemptedAtMs: NIGHT.startMs, attemptBaselinePct: 16 };
  assert.equal(revertRetryPending(attempted, 50, true), true, 'it reads our target: adopted, then restored');
  assert.equal(revertRetryPending(attempted, null, true), false);
  // The stuck restore's own close: by the 05:30 page the re-issues are spent, and the push says so.
  const stuck = simulateClose({ tickOffsetMs: 37_000, lagMs: 0, takes: false });
  assert.equal(revertRetryPending(stuck.s, 50, true), false);
  const push = buildNightChargeRevertDeadline({ day: '2026-10-13', stage: 'deadline', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', retrying: false });
  assert.match(push.body, /The add-on is not re-sending the restore\.$/);
  assert.doesNotMatch(push.body, /keeps retrying/);
  assert.match(buildNightChargeRevertDeadline({ day: '2026-10-13', stage: 'deadline', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', retrying: true }).body, /keeps retrying the restore\.$/);
});

test('★★★ a partly granted write: the night\'s own request read back later is ours — adopted as the target and restored at the close', () => {
  const s = applied(arm(NIGHT), { applyVerifiedAtMs: null });
  const verifyAt = NIGHT.startMs + APPLY_VERIFY_AFTER_MS;
  assert.deepEqual(decideActuation(s, verifyAt, ropts({ currentReservePct: 30 })), { kind: 'applyCeiling', achievedPct: 30 });
  const ceiling = { ...s, targetPct: 30, requestedPct: 50, applyVerifiedAtMs: verifyAt };
  // 01:00: the panel now reads the 50% the night asked for — not someone else's.
  const t1 = NIGHT.startMs + 2 * HOUR;
  assert.equal(isForeignReserveReading(ceiling, 50), false);
  assert.deepEqual(decideActuation(ceiling, t1, ropts({ currentReservePct: 50 })), { kind: 'ceilingMoved', pct: 50 });
  const moved = { ...ceiling, targetPct: 50 };
  assert.equal(decideActuation(moved, t1 + 10 * MIN, ropts({ currentReservePct: 50 })).kind, 'none');
  assert.deepEqual(decideActuation(moved, NIGHT.endMs, ropts({ currentReservePct: 50 })), { kind: 'revert', restorePct: 16 }, 'restored at the close');
  // A stuck restore of it pages and holds against what the panel holds.
  const stuck = { ...moved, revertedAtMs: NIGHT.endMs };
  assert.deepEqual(decideRevertDeadline(stuck, revertDeadlineMs(stuck)!, 50), { kind: 'page', stage: 'deadline', unknown: false });
  assert.equal(chargeWriteHold(stuck)?.targetPct, 50);
  // Inside the request: ours; outside it: still someone else's on two readings.
  for (const v of [17, 30, 40, 50]) assert.equal(isOwnReserveValue(ceiling, v), true, `${v}% is within what was asked`);
  for (const v of [10, 12, 15]) assert.equal(isOwnReserveValue(ceiling, v), false, `${v}% is below the baseline`);
  assert.deepEqual(decideActuation(ceiling, t1, ropts({ currentReservePct: 12 })), { kind: 'foreignSeen', pct: 12 });
  assert.equal(ceilingMovedPct(ceiling, 40), 40);
  assert.equal(ceilingMovedPct(ceiling, 30), null, 'the adopted target');
  assert.equal(ceilingMovedPct(ceiling, null), null);
  assert.equal(ceilingMovedPct({ ...ceiling, requestedPct: null }, 40), null, 'a write taken in full has no band');
  assert.equal(isOwnReserveValue({ ...ceiling, requestedPct: null }, 40), false);
  // A pending sighting is cleared by a value within the request.
  assert.deepEqual(foreignStep({ ...ceiling, foreignReservePct: 12, foreignSeenAtMs: t1 }, 40, t1 + MIN), { kind: 'foreignCleared' });
});

test('★★ after a restore of a write that never read back, a short reading is the panel\'s partial answer, not someone else\'s', () => {
  // Applied, the panel took it only part way (35, not yet adopted), cancelled at 23:02.
  const s = { ...applied(arm(NIGHT), { applyVerifiedAtMs: null }), cancelled: true, revertedAtMs: NIGHT.startMs + 3 * MIN };
  assert.equal(decideActuation(s, NIGHT.startMs + 4 * MIN, ropts({ currentReservePct: 35 })).kind, 'none');
  assert.equal(decideActuation({ ...s, foreignReservePct: 35, foreignSeenAtMs: NIGHT.startMs + 4 * MIN }, NIGHT.startMs + 10 * MIN, ropts({ currentReservePct: 35 })).kind, 'none', 'never settles foreign');
  // Once the write had read back, the rule applies after the restore as before it.
  assert.deepEqual(decideActuation({ ...s, applyVerifiedAtMs: NIGHT.startMs + MIN }, NIGHT.startMs + 4 * MIN, ropts({ currentReservePct: 35 })), { kind: 'foreignSeen', pct: 35 });
});

test('★★★ a Friday window\'s stuck restore survives Saturday\'s arm: Monday\'s on-peak page and the money detectors\' hold stay', () => {
  // Friday 23:00 → Saturday 00:00, its on-peak start Monday 16:00. Applied, restore ACK'd at the
  // close, the panel still reads 50, the re-issues spent.
  const FRI = { startMs: phx(2026, 10, 16, 23), endMs: phx(2026, 10, 17, 0) };
  const MON_PEAK = phx(2026, 10, 19, 16);
  const fri = applied(arm(FRI));
  assert.equal(fri.nextOnPeakStartMs, MON_PEAK);
  const stuck = { ...fri, revertedAtMs: FRI.endMs, revertRetries: REVERT_MAX_RETRIES, revertReadbackEscalated: true, revertDeadlinePagedAtMs: FRI.endMs + 30 * MIN };
  assert.equal(restoreUnconfirmed(stuck, 50), true);
  assert.equal(restoreUnconfirmed(stuck, null), true, 'no reading: it may still stand');
  assert.equal(restoreUnconfirmed(stuck, 16), false, 'the restore');
  assert.equal(restoreUnconfirmed(stuck, 30), false, 'someone else\'s value (the foreign rule settles it)');
  assert.equal(restoreUnconfirmed({ ...stuck, revertVerifiedAtMs: FRI.endMs + MIN }, 50), false);
  // Saturday 21:30: the plan for the shared Monday 00:00–05:00 window is refused, with the words.
  const SAT_ARM = phx(2026, 10, 17, 21, 30);
  const MON = { startMs: phx(2026, 10, 19, 0), endMs: phx(2026, 10, 19, 5) };
  const why = /^the 2026-10-13 reserve restore was sent and has not read back \(the panel still reads 50%\)$/;
  assert.match(armOpenItem(stuck, 50) ?? '', why);
  assert.equal(armFromPlan(stuck, '2026-10-17', plan(MON), SAT_ARM, 50, true, MON_PEAK), null);
  assert.match(armRefusalReason(stuck, plan(MON), SAT_ARM, 50) ?? '', why);
  const cyc = armCycle({ active: asChargeLeg(stuck), pendingLegs: [], trailing: null }, '2026-10-17',
    [{ role: 'cost', kind: 'overnight', plan: plan(MON), forceChargeEnabled: true, nextOnPeakStartMs: MON_PEAK }], SAT_ARM, 50);
  assert.equal(cyc.cycle, null);
  assert.match(cyc.refused[0]?.reason ?? '', why);
  assert.equal(legResolved(stuck, SAT_ARM, 50), false, 'the cycle\'s own predicate agrees');
  assert.match(armOpenItem(stuck, null) ?? '', /has not read back \(the panel is not reporting its reserve\)$/);
  // The record stays, so Monday's on-peak start pages and the money detectors measure past it.
  assert.deepEqual(decideRevertDeadline(stuck, MON_PEAK, 50), { kind: 'page', stage: 'onPeak', unknown: false });
  assert.deepEqual(moneyDetectorReservePct(50, chargeWriteHold(stuck), MON_PEAK + 30 * MIN), { reservePct: 16, heldByChargeWrite: true });
  // Corrected in the app (the panel reads 16): the restore reads back, and the next evening arms.
  assert.equal(armOpenItem(stuck, 16), null);
  assert.deepEqual(decideActuation(stuck, SAT_ARM + 5 * MIN, ropts({ currentReservePct: 16 })), { kind: 'revertVerified' });
});

/* ══ the failure paths, reviewed again: no garbage reading decides a page, a restart lets the restore go first, the words name the day ══ */

test('★★★ revertDeadline: a reading that is not a reserve setting — a reconnect 0, a fraction, out of the envelope — is no reading, at both stages and at the arm', () => {
  // Applied and read back, the restore ACK'd at 05:00:20 and never read back.
  const s = { ...applied(arm(NIGHT)), revertedAtMs: NIGHT.endMs + 20_000 };
  const deadline = revertDeadlineMs(s)!;
  const paged = { ...s, revertDeadlinePagedAtMs: deadline };
  const next = { startMs: phx(2026, 10, 14, 23), endMs: phx(2026, 10, 15, 5) };
  for (const v of [0, 0.5, 5, 9, 51, 100, -1, 30.5]) {
    assert.equal(isReserveSetting(v), false, `${v}`);
    assert.deepEqual(decideRevertDeadline(s, deadline, v), { kind: 'page', stage: 'deadline', unknown: true }, `${v}: the deadline pages, unconfirmed`);
    assert.deepEqual(decideRevertDeadline(paged, NIGHT_PEAK, v), { kind: 'page', stage: 'onPeak', unknown: true }, `${v}: the on-peak start pages`);
    assert.equal(restoreUnconfirmed(s, v), true, `${v}: the restore is still unconfirmed`);
    assert.equal(armOpenItem(s, v), `the 2026-10-13 reserve restore was sent and has not read back (the panel reads ${v}, not a valid reserve)`);
    assert.equal(armFromPlan(s, '2026-10-14', plan(next), next.startMs - 90 * MIN, v, true, nextOnPeakStartMs(REV, next.startMs)), null, `${v}: the next arm does not bury the record`);
  }
  // A setting decides as before: the restore read back, or a value someone else set.
  assert.deepEqual(decideRevertDeadline(s, deadline, 16), { kind: 'pass', stage: 'deadline', pct: 16 });
  assert.deepEqual(decideRevertDeadline(s, deadline, 30), { kind: 'pass', stage: 'deadline', pct: 30 });
  assert.deepEqual(decideRevertDeadline(s, deadline, 50), { kind: 'page', stage: 'deadline', unknown: false });
  assert.equal(restoreUnconfirmed(s, 30), false);
  assert.equal(restoreUnconfirmed(s, 50), true);
  assert.equal(armOpenItem(s, 50), 'the 2026-10-13 reserve restore was sent and has not read back (the panel still reads 50%)');
  assert.equal(armOpenItem(s, null), 'the 2026-10-13 reserve restore was sent and has not read back (the panel is not reporting its reserve)');
  for (const v of [10, 16, 50]) assert.equal(isReserveSetting(v), true);
  assert.equal(isReserveSetting(null), false);
  // A reconnect 0 at both moments, then dark: both pages still go out (before, the 0 passed both stages).
  let r = s;
  let pages = 0;
  for (let t = NIGHT.endMs; t <= NIGHT_PEAK + HOUR; t += MIN) {
    const reading = t === deadline || t === NIGHT_PEAK ? 0 : null;
    const d = decideRevertDeadline(r, t, reading);
    if (d.kind === 'page') {
      pages++;
      r = { ...r, revertDeadlinePagedAtMs: r.revertDeadlinePagedAtMs ?? t, revertDeadlineOnPeakPagedAtMs: d.stage === 'onPeak' ? t : r.revertDeadlineOnPeakPagedAtMs };
    }
    assert.notEqual(d.kind, 'pass', `${new Date(t).toISOString()}: nothing decides a stage without a page`);
  }
  assert.equal(pages, 2);
});

test('★★★ revertDeadline after a restart across the deadline: the restore goes first; the deadline pages only if it is rejected, does not read back, or cannot be sent', () => {
  // Applied 23:00 and read back (prior 16); the process went down at 04:50 and its first tick is at 05:31.
  const s = applied(arm(NIGHT));
  const deadline = revertDeadlineMs(s)!;
  const t1 = deadline + MIN;
  assert.equal(restoreAwaitingFirstChance(s, t1, true), true);
  assert.deepEqual(decideRevertDeadline(s, t1, 50, true), { kind: 'hold', stage: 'deadline' });
  assert.deepEqual(decideRevertDeadline(s, t1, null, true), { kind: 'hold', stage: 'deadline' });
  assert.deepEqual(decideActuation(s, t1, ropts({ currentReservePct: 50 })), { kind: 'revert', restorePct: 16 }, 'sent on that same tick');
  // Nothing will be sent: the panel missing from the device list, or no valid value to restore — paged at once, as before.
  assert.deepEqual(decideRevertDeadline(s, t1, null, false), { kind: 'page', stage: 'deadline', unknown: true });
  assert.deepEqual(decideRevertDeadline(s, t1, null), { kind: 'page', stage: 'deadline', unknown: true }, 'the default never waits');
  assert.deepEqual(decideRevertDeadline({ ...s, priorReservePct: 7 }, t1, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  // Rejected: paged on the next tick.
  assert.deepEqual(decideRevertDeadline({ ...s, revertAttempts: 1, revertDeadlineHeldAtMs: t1 }, t1 + MIN, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  // Accepted: it waits out the restore's readback grace, then pages if the panel still reads 50.
  const sent = { ...s, revertedAtMs: t1, revertDeadlineHeldAtMs: t1 };
  assert.deepEqual(decideRevertDeadline(sent, t1 + MIN, 50, true), { kind: 'hold', stage: 'deadline' });
  assert.deepEqual(decideRevertDeadline(sent, t1 + REVERT_VERIFY_AFTER_MS - 1, 50, true), { kind: 'hold', stage: 'deadline' });
  assert.deepEqual(decideRevertDeadline(sent, t1 + REVERT_VERIFY_AFTER_MS, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  assert.deepEqual(decideRevertDeadline(sent, t1 + 2 * MIN, 16, true), { kind: 'pass', stage: 'deadline', pct: 16 }, 'read back');
  // Bounded: a restore that never gets sent (rate-limited every tick) waits REVERT_DEADLINE_HOLD_MAX_MS at most.
  const held = { ...s, revertDeadlineHeldAtMs: t1 };
  assert.equal(REVERT_DEADLINE_HOLD_MAX_MS, 10 * MIN);
  assert.deepEqual(decideRevertDeadline(held, t1 + REVERT_DEADLINE_HOLD_MAX_MS - 1, 50, true), { kind: 'hold', stage: 'deadline' });
  assert.deepEqual(decideRevertDeadline(held, t1 + REVERT_DEADLINE_HOLD_MAX_MS, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  assert.deepEqual(decideRevertDeadline({ ...sent, revertDeadlineHeldAtMs: t1 - REVERT_DEADLINE_HOLD_MAX_MS }, t1 + MIN, 50, true), { kind: 'page', stage: 'deadline', unknown: false }, 'the bound outranks the grace');
  // The on-peak stage never waits: a process down through on-peak is paged at once.
  assert.deepEqual(decideRevertDeadline(s, NIGHT_PEAK + MIN, 50, true), { kind: 'page', stage: 'onPeak', unknown: false });
  // A restore sent at the close is long past its grace at the deadline: a stuck one pages as before.
  assert.deepEqual(decideRevertDeadline({ ...s, revertedAtMs: NIGHT.endMs + 20_000 }, deadline, 50, true), { kind: 'page', stage: 'deadline', unknown: false });
  assert.equal(restoreAwaitingFirstChance({ ...s, revertVerifiedAtMs: t1 }, t1, true), false);
  assert.equal(restoreAwaitingFirstChance(arm(NIGHT), t1, true), false, 'nothing applied');
});

/** A process back at `backMs` on an applied night whose restore was never sent, ticking each minute
 *  as the integrator does: the page decision first (its stamps), then the reserve decision. The
 *  panel reads 16 `lagMs` after an accepted restore when it takes. Returns the pages, with their
 *  moment and the record at it. */
function simulateRestart(o: { backMs: number; takes: boolean; lagMs?: number; rejectFirst?: number; untilMs?: number }) {
  let s = applied(arm(NIGHT));
  let rejects = o.rejectFirst ?? 0;
  const pages: Array<{ t: number; d: RevertDeadlineDecisionLike; s: NightActuationState }> = [];
  const reading = (t: number): number => (o.takes && s.revertedAtMs != null && t >= s.revertedAtMs + (o.lagMs ?? 40_000) ? 16 : 50);
  for (let t = o.backMs; t <= (o.untilMs ?? o.backMs + 2 * HOUR); t += MIN) {
    const d = decideRevertDeadline(s, t, reading(t), true);
    if (d.kind === 'hold' && s.revertDeadlineHeldAtMs == null) s = { ...s, revertDeadlineHeldAtMs: t };
    if (d.kind === 'page') {
      pages.push({ t, d, s });
      s = { ...s, revertDeadlinePagedAtMs: s.revertDeadlinePagedAtMs ?? t, revertDeadlineOnPeakPagedAtMs: d.stage === 'onPeak' ? t : s.revertDeadlineOnPeakPagedAtMs };
    }
    if (d.kind === 'pass') s = d.stage === 'onPeak' ? { ...s, revertDeadlineOnPeakPassedAtMs: t } : { ...s, revertDeadlinePassedAtMs: t };
    const a = decideActuation(s, t, ropts({ currentReservePct: reading(t) }));
    if (a.kind === 'revert') {
      if (rejects > 0) { rejects--; s = { ...s, revertAttempts: s.revertAttempts + 1 }; } else s = { ...s, revertedAtMs: t };
    } else if (a.kind === 'revertVerified') s = { ...s, revertVerifiedAtMs: t };
    else if (a.kind === 'retryRevert') s = { ...s, revertRetries: s.revertRetries + 1, revertLastAttemptMs: t };
    else if (a.kind === 'revertFailed') s = { ...s, revertReadbackEscalated: true };
  }
  return { s, pages };
}
type RevertDeadlineDecisionLike = ReturnType<typeof decideRevertDeadline>;

test('★★★ a restart across the deadline, tick by tick: no page when the restore then takes; one, after its readback grace, when it does not', () => {
  const deadline = NIGHT.endMs + REVERT_DEADLINE_AFTER_WINDOW_MS;
  for (const back of [deadline, deadline + 37_000, deadline + HOUR, phx(2026, 10, 14, 8), NIGHT_PEAK - 20 * MIN]) {
    for (const lagMs of [20_000, 60_000, 4 * MIN]) {
      const ok = simulateRestart({ backMs: back, takes: true, lagMs });
      assert.deepEqual(ok.pages, [], `back at ${new Date(back).toISOString()}, readback ${lagMs / 1000}s: nothing paged`);
      assert.ok(ok.s.revertVerifiedAtMs != null);
    }
    if (back > NIGHT_PEAK - REVERT_DEADLINE_HOLD_MAX_MS) continue; // the on-peak stage takes over
    const stuck = simulateRestart({ backMs: back, takes: false });
    const first = stuck.pages[0];
    assert.ok(first != null && first.d.kind === 'page' && first.d.stage === 'deadline' && first.d.unknown === false, `back at ${new Date(back).toISOString()}: the stuck restore is paged`);
    assert.ok(first.s.revertedAtMs != null && first.t >= first.s.revertedAtMs + REVERT_VERIFY_AFTER_MS, 'only after the restore was sent and had its readback grace');
    assert.ok(first.t - back <= REVERT_DEADLINE_HOLD_MAX_MS, 'within the bound');
    // Rejected once, then accepted and stuck: paged on the rejection — the restore had its chance.
    const rejected = simulateRestart({ backMs: back, takes: false, rejectFirst: 1 });
    assert.equal(rejected.pages[0]?.t, back + MIN, 'the tick after the rejection');
  }
});

test('★★★ an ACK\'d write the apply ladder proved never took effect is not paged when the readback goes dark at the close', () => {
  // Cloud-ACK'd at 23:00; both re-issues read the 16% baseline; applyFailed; the panel reads 16.
  let s: NightActuationState = { ...applied(arm(NIGHT)), applyVerifiedAtMs: null };
  let stampedAt: number | null = null;
  for (let t = NIGHT.startMs + MIN; t <= NIGHT.startMs + HOUR; t += MIN) {
    if (applyProvedUnlanded(s, 16, t)) { s = { ...s, applyUnlandedAtMs: t }; stampedAt ??= t; }
    const a = decideActuation(s, t, ropts({ currentReservePct: 16 }));
    if (a.kind === 'retryApply') s = { ...s, applyRetries: s.applyRetries + 1, applyLastAttemptMs: t };
    else if (a.kind === 'applyFailed') s = { ...s, applyEscalated: true };
    else assert.ok(a.kind === 'none', `${a.kind}`);
  }
  assert.equal(s.applyRetries, APPLY_MAX_RETRIES);
  assert.equal(s.applyEscalated, true);
  assert.ok(stampedAt != null && stampedAt >= s.applyLastAttemptMs! + APPLY_VERIFY_AFTER_MS, 'proven after the ladder, on the baseline');
  assert.equal(revertOutstanding(s), false);
  // The 05:00 restore is still sent (a no-op), ACK'd — or not — and the readback goes dark: no page, no hold on the next arm.
  assert.deepEqual(decideActuation(s, NIGHT.endMs, ropts({ currentReservePct: null })), { kind: 'revert', restorePct: 16 });
  for (const r of [{ ...s, revertedAtMs: NIGHT.endMs }, s]) {
    assert.deepEqual(decideRevertDeadline(r, revertDeadlineMs(r)!, null), { kind: 'none' });
    assert.deepEqual(decideRevertDeadline(r, NIGHT_PEAK, null), { kind: 'none' });
    assert.equal(restoreUnconfirmed(r, null), false);
    assert.equal(chargeWriteHold(r), null, 'the money detectors are not held');
  }
  // The proof needs the ladder over, the grace run, the baseline read live — and no verification, no restore.
  const ladder = { ...applied(arm(NIGHT)), applyVerifiedAtMs: null, applyRetries: 2, applyLastAttemptMs: NIGHT.startMs + 10 * MIN, applyEscalated: true };
  const after = NIGHT.startMs + 10 * MIN + APPLY_VERIFY_AFTER_MS;
  assert.equal(applyProvedUnlanded(ladder, 16, after), true);
  assert.equal(applyProvedUnlanded(ladder, 16, after - 1), false, 'inside the last attempt\'s readback grace');
  assert.equal(applyProvedUnlanded({ ...ladder, applyEscalated: false }, 16, after), false, 'the ladder is not over');
  assert.equal(applyProvedUnlanded(ladder, null, after), false, 'no reading proves nothing');
  assert.equal(applyProvedUnlanded(ladder, 50, after), false, 'our target: it landed');
  assert.equal(applyProvedUnlanded(ladder, 30, after), false, 'not the baseline');
  assert.equal(applyProvedUnlanded({ ...ladder, applyVerifiedAtMs: NIGHT.startMs + MIN }, 16, after), false, 'verified');
  assert.equal(applyProvedUnlanded({ ...ladder, revertedAtMs: NIGHT.endMs }, 16, NIGHT.endMs + HOUR), false, 'restored');
  assert.equal(applyProvedUnlanded({ ...ladder, applyUnlandedAtMs: after }, 16, after + MIN), false, 'stamped once');
  assert.equal(applyProvedUnlanded({ ...arm(NIGHT), applyAttemptedAtMs: NIGHT.startMs, attemptBaselinePct: 16, applyEscalated: true }, 16, after), false, 'an unconfirmed attempt is attemptProvedUnlanded\'s');
  // A late landing outranks the proof: verified, it is outstanding again, restored, and paged if stuck.
  const proven = { ...ladder, applyUnlandedAtMs: after };
  assert.deepEqual(decideActuation(proven, NIGHT.startMs + 2 * HOUR, ropts({ currentReservePct: 50 })), { kind: 'applyVerified' });
  const late = { ...proven, applyVerifiedAtMs: NIGHT.startMs + 2 * HOUR };
  assert.equal(revertOutstanding(late), true);
  const lateStuck = { ...late, revertedAtMs: NIGHT.endMs };
  assert.deepEqual(decideRevertDeadline(lateStuck, revertDeadlineMs(lateStuck)!, null), { kind: 'page', stage: 'deadline', unknown: true });
  assert.equal(restoreUnconfirmed(lateStuck, null), true);
  assert.ok(chargeWriteHold(late) != null);
  // It round-trips through the file.
  assert.equal(coerceActuationState(JSON.parse(JSON.stringify(proven))).applyUnlandedAtMs, after);
  assert.equal(coerceActuationState(JSON.parse(JSON.stringify({ ...proven, revertDeadlineHeldAtMs: after }))).revertDeadlineHeldAtMs, after);
  assert.equal(coerceActuationState({ day: '2026-10-13' }).applyUnlandedAtMs, null);
});

test('★★★ the deadline page names the on-peak day when it is not the page\'s: a Friday window, a holiday eve — and the bare clock on the same day', () => {
  const periodId = (t: number) => rateAt(REV, t).periodId;
  const cases: Array<{ name: string; armAt: number; en: string | null; es: string | null }> = [
    { name: 'Friday 2026-12-04', armAt: phx(2026, 12, 4, 21, 30), en: 'on Monday', es: 'el lunes' },
    { name: 'the eve of Thanksgiving 2026-11-25', armAt: phx(2026, 11, 25, 21, 30), en: 'on Friday', es: 'el viernes' },
    { name: 'Tuesday 2026-10-13', armAt: phx(2026, 10, 13, 21, 30), en: null, es: null },
    { name: 'Thursday 2026-12-03', armAt: phx(2026, 12, 3, 21, 30), en: null, es: null },
  ];
  for (const c of cases) {
    const w = resolveCheapWindow(periodId, c.armAt, 'overnight', 30)!;
    assert.ok(w != null, c.name);
    const s = { ...applied(arm(w, true, c.armAt)), revertedAtMs: w.endMs };
    const at = revertDeadlineMs(s)! + MIN;
    assert.deepEqual(decideRevertDeadline(s, at, 50), { kind: 'page', stage: 'deadline', unknown: false }, c.name);
    const day = onPeakDayWords(s.nextOnPeakStartMs!, at);
    assert.deepEqual(day, c.en == null ? null : { en: c.en, es: c.es }, c.name);
    const spoken = revertDeadlineSpoken({ stage: 'deadline', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', onPeakDay: day });
    const push = buildNightChargeRevertDeadline({ day: s.day, stage: 'deadline', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', onPeakDay: day, retrying: true });
    if (c.en == null) {
      assert.match(spoken.en, /, and on-peak pricing starts at 4:00 PM\. /, c.name);
      assert.match(spoken.es, /, y la tarifa punta comienza a las 4:00 PM\. /, c.name);
      assert.match(push.body, / On-peak pricing starts at 4:00 PM\. /, c.name);
    } else {
      assert.ok(spoken.en.includes(`, and on-peak pricing starts ${c.en} at 4:00 PM. `), `${c.name}: ${spoken.en}`);
      assert.ok(spoken.es.includes(`, y la tarifa punta comienza ${c.es} a las 4:00 PM. `), `${c.name}: ${spoken.es}`);
      assert.ok(push.body.includes(` On-peak pricing starts ${c.en} at 4:00 PM. `), `${c.name}: ${push.body}`);
    }
    assert.ok(spoken.en.length + spoken.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${c.name}: ${spoken.en.length + spoken.es.length}`);
    // The unknown page too, and the on-peak stage keeps "has started" / "started at".
    const unk = revertDeadlineSpoken({ stage: 'deadline', unknown: true, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', onPeakDay: day });
    assert.ok(unk.en.includes(`on-peak pricing starts ${c.en != null ? `${c.en} ` : ''}at 4:00 PM.`), unk.en);
    assert.ok(unk.en.length + unk.es.length <= MAX_SPOKEN_ADVISORY_CHARS);
  }
  // The next date is named by its weekday too, never "tomorrow" (heard at 12:30 AM as the day just
  // begun); the same date keeps the bare clock.
  assert.deepEqual(onPeakDayWords(phx(2026, 10, 15, 16), phx(2026, 10, 14, 17)), { en: 'on Thursday', es: 'el jueves' });
  assert.deepEqual(onPeakDayWords(phx(2026, 10, 15, 16), phx(2026, 10, 14, 23, 59)), { en: 'on Thursday', es: 'el jueves' });
  assert.equal(onPeakDayWords(phx(2026, 10, 14, 16), phx(2026, 10, 14, 0, 30)), null);
  assert.equal(onPeakDayWords(phx(2026, 10, 14, 16), phx(2026, 10, 14, 15, 59)), null);
  // Every weekday, every shape: within the spoken bound.
  for (const wd of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    const ms = [...Array(7).keys()].map((k) => phx(2026, 10, 19 + k, 16)).find((t) => onPeakDayWords(t, phx(2026, 10, 18, 1))?.en === `on ${wd}`)!;
    const day = onPeakDayWords(ms, phx(2026, 10, 18, 1))!;
    for (const unknown of [true, false]) for (const restorePct of [16, null]) {
      const t = revertDeadlineSpoken({ stage: 'deadline', unknown, targetPct: 50, restorePct, onPeakClock: '4:00 PM', onPeakDay: day });
      assert.ok(t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${wd}/${unknown}/${restorePct}: ${t.en.length + t.es.length}`);
    }
  }
  const onPeak = buildNightChargeRevertDeadline({ day: '2026-12-04', stage: 'onPeak', unknown: false, targetPct: 50, restorePct: 16, onPeakClock: '4:00 PM', onPeakDay: { en: 'on Monday', es: 'el lunes' }, retrying: true });
  assert.match(onPeak.body, / On-peak pricing started at 4:00 PM\. /, 'the on-peak stage is said when it starts');
});
