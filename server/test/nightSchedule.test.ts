import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tariffModelFromEnv, failClosedTariffModel, rateAt, cheapPeriodIdOf, type TariffModel } from '../src/tariff.js';
import {
  nightScheduleOf, nominalCheapWindow, nightScheduleRepairIssues, nightScheduleLogLine, APS_NIGHT_SCHEDULE,
  NIGHT_NOTIFY_CLAMPED_ISSUE_ID, fmtMinuteOfDay,
} from '../src/nightSchedule.js';
import {
  nightWindowBounds, nextFullCheapWindow, longGapAhead, eveningBasisDefers, resolveCheapWindow,
  NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, FULL_CHEAP_WINDOW_MIN_MS, APS_FALLBACK_NIGHT,
} from '../src/nightChargeAdvisor.js';
import { decideForceCharge, forceChargeRunCapMs, FORCE_CHARGE_MAX_RUN_MS, type ForceChargeOpts } from '../src/nightForceCharge.js';
import { emptyActuationState, armFromPlan, APPLY_LATE_MS, type NightActuationState } from '../src/nightChargeActuator.js';
import { computeNightChargeReadiness, CURRENT_ALGO_VERSION } from '../src/nightChargeGate.js';

/**
 * v1.191.0 (S6; plan 3.4 W2–W6, CA15) — THE NIGHT-CHARGE SCHEDULE AS DATA.
 *
 * The evening job's catch-up window, the notify-hour clamp, the stale-panel deferral, the scorer's
 * fallback night, the full-window minimum and the force-charge backstop were the APS window's
 * constants. They now come from nightSchedule.ts: the APS preset keeps them verbatim (whatever the
 * notify time: plan 6.4 item 5), another plan derives them from its own cheap window. Without this a
 * cheap window opening at or before 21:00 was planned inside the window at the default 21:30, and a
 * write mode refused every night (the window opened more than 30 minutes earlier).
 */

const H = 3_600_000;
const phx = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h + 7, min);
const KEYS = [
  'TARIFF_PLAN', 'TARIFF_PERIODS', 'TARIFF_RATES', 'TARIFF_RATES_CONFIRMED', 'NIGHT_CHARGE_CHEAP_PERIOD',
  'TARIFF_ON_PEAK_HOURS', 'TARIFF_ON_PEAK_DAYS', 'TARIFF_ON_PEAK_CENTS', 'TARIFF_OFF_PEAK_CENTS', 'TARIFF_FLAT_CENTS_PER_KWH',
];
function modelWith(patch: Record<string, string>): TariffModel {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return tariffModelFromEnv(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const custom = (periods: string, rates: string) => modelWith({ TARIFF_PLAN: 'custom', TARIFF_PERIODS: periods, TARIFF_RATES: rates, TARIFF_RATES_CONFIRMED: 'true' });
const APS = modelWith({});
const N2206 = custom('peak 16-20 mon-fri all onpeak; night 22-06 all all cheap', 'peak=30; night=10; off_peak=15');
const N0007 = custom('peak 14-19 mon-fri all onpeak; night 00-07 all all cheap', 'peak=34; night=9.5; off_peak=15');
const N2107 = custom('peak 14-19 mon-fri all onpeak; overnight 21-07 all all cheap', 'peak=30; overnight=10; off_peak=15');
const SHORT = custom('peak 16-21 mon-fri all onpeak; super 01-03 all all cheap', 'peak=30; super=6; off_peak=15');
const MIDDAY = custom('peak 17-21 all all onpeak; solar 10-15 all all cheap', 'peak=30; solar=5; off_peak=15');
const TWO_TIER_OFF = modelWith({
  TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19', TARIFF_ON_PEAK_DAYS: '1-5',
  TARIFF_ON_PEAK_CENTS: '30', TARIFF_OFF_PEAK_CENTS: '12', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak',
});
const DEFAULT_NOTIFY = { hour: 21, minute: 30 };

test('★★★ the APS preset keeps today\'s constants verbatim, whatever the notify time', () => {
  for (const n of [DEFAULT_NOTIFY, { hour: 21, minute: 0 }, { hour: 20, minute: 0 }, { hour: 22, minute: 45 }, { hour: 0, minute: 0 }]) {
    const s = nightScheduleOf(APS, n);
    assert.equal(s.source, 'aps_r_ev');
    assert.equal(s.cheapPeriodId, 'overnight');
    assert.equal(s.eveningCutoffMin, 23 * 60);
    assert.equal(s.notifyHourMax, 22);
    // A 21:00 or 20:00 notify keeps the 22:30 deferral (a derived rule would move it: plan 6.4 item 5).
    assert.equal(s.staleDeferUntilMin, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN, `notify ${n.hour}:${n.minute}`);
    assert.deepEqual(s.fallbackNight, { windowStartMin: 23 * 60, windowEndMin: 29 * 60, completeMin: 45 * 60 });
    assert.equal(s.fullWindowMinMs, FULL_CHEAP_WINDOW_MIN_MS);
    assert.equal(s.forceChargeMaxRunMs, FORCE_CHARGE_MAX_RUN_MS);
    assert.deepEqual(s.notify, { hour: n.hour, minute: n.minute, fireMin: n.hour * 60 + n.minute, clampedFrom: null });
    assert.deepEqual(nightScheduleRepairIssues(s), [], 'never a repair issue on the preset');
    assert.equal(nightScheduleLogLine(s), null, 'and no new boot line');
  }
  assert.equal(APS_NIGHT_SCHEDULE.staleDeferUntilMin, 22 * 60 + 30);
  assert.equal(APS_NIGHT_SCHEDULE.fallbackNight, APS_FALLBACK_NIGHT, 'one copy of the APS night');
  // The APS preset with its own period named explicitly is the same schedule.
  const named = modelWith({ NIGHT_CHARGE_CHEAP_PERIOD: 'overnight' });
  assert.equal(nightScheduleOf(named, DEFAULT_NOTIFY).source, 'aps_r_ev');
  // nightWindowBounds with the preset's night is the bounds it always gave.
  for (const d of ['2026-03-08', '2026-06-21', '2026-11-01', '2026-12-31']) {
    assert.deepEqual(nightWindowBounds(d, nightScheduleOf(APS, DEFAULT_NOTIFY).fallbackNight), nightWindowBounds(d));
  }
});

test('★★★ a custom 22:00–06:00 window: cutoff 22:00, notify clamp 21, deferral min(fire + 60, 21:30), run cap 9 h', () => {
  const s = nightScheduleOf(N2206, DEFAULT_NOTIFY);
  assert.equal(s.source, 'derived');
  assert.deepEqual(s.window, { openMin: 22 * 60, closeMin: 30 * 60 });
  assert.equal(s.eveningCutoffMin, 22 * 60);
  assert.equal(s.notifyHourMax, 21);
  assert.equal(s.notify.fireMin, 21 * 60 + 30);
  assert.equal(s.staleDeferUntilMin, 21 * 60 + 30, 'no deferral past 21:30: the window opens at 22:00');
  assert.equal(nightScheduleOf(N2206, { hour: 20, minute: 0 }).staleDeferUntilMin, 21 * 60, 'a 20:00 notify defers to 21:00');
  assert.equal(s.forceChargeMaxRunMs, 9 * H);
  assert.deepEqual(s.fallbackNight, { windowStartMin: 22 * 60, windowEndMin: 30 * 60, completeMin: 46 * 60 });
  assert.equal(s.fullWindowMinMs, 3 * H);
  // A 22:15 notify is clamped to 21:15, and that is reported.
  const late = nightScheduleOf(N2206, { hour: 22, minute: 15 });
  assert.deepEqual(late.notify, { hour: 21, minute: 15, fireMin: 21 * 60 + 15, clampedFrom: { hour: 22, minute: 15 } });
  const issues = nightScheduleRepairIssues(late, 1_000);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, NIGHT_NOTIFY_CLAMPED_ISSUE_ID);
  assert.match(issues[0].title, /moved to 21:15, before the cheap window opens at 22:00/);
  assert.match(nightScheduleLogLine(late)!, /evening job at 21:15 \(NIGHT_CHARGE_NOTIFY_HOUR 22 is clamped to 21\)/);
  assert.deepEqual(nightScheduleRepairIssues(s), [], 'an unclamped notify raises nothing');
});

test('★★★ the finding\'s scenario: a 21:00–07:00 window plans at 20:30, before the open, so a write mode arms it', () => {
  const s = nightScheduleOf(N2107, DEFAULT_NOTIFY);
  assert.equal(s.notify.fireMin, 20 * 60 + 30, 'the default 21:30 is moved before the 21:00 open');
  assert.equal(s.eveningCutoffMin, 21 * 60);
  assert.equal(s.staleDeferUntilMin, 20 * 60 + 30, 'no deferral: a deferred plan would be inside the window');
  assert.equal(s.forceChargeMaxRunMs, 11 * H, 'the 10 h window is not cut at 7 h');
  // At the fire time the window opens 30 min later: the arm is accepted. At 21:30 (the old fire) it was refused.
  const pid = (t: number) => rateAt(N2107, t).periodId;
  const fire = phx(2026, 11, 4, 20, 30);
  const w = resolveCheapWindow(pid, fire, cheapPeriodIdOf(N2107)!, 30)!;
  assert.deepEqual(w, { startMs: phx(2026, 11, 4, 21), endMs: phx(2026, 11, 5, 7) });
  const plan = { chargeTonight: true, basisComplete: true, window: w, setpointSocPct: 40, buyKwh: 20 } as unknown as Parameters<typeof armFromPlan>[2];
  assert.ok(armFromPlan(emptyActuationState(), '2026-11-04', plan, fire, 20) != null, 'armed at 20:30');
  assert.equal(armFromPlan(emptyActuationState(), '2026-11-04', plan, phx(2026, 11, 4, 21, 30), 20), null,
    'what the APS schedule did: refused at 21:30 (the window opened APPLY_LATE_MS earlier)');
  assert.equal(APPLY_LATE_MS, 30 * 60_000);
});

test('★★ a window opening after midnight: the evening job may run until midnight; the hour stays under 22', () => {
  const s = nightScheduleOf(N0007, DEFAULT_NOTIFY);
  assert.deepEqual(s.window, { openMin: 24 * 60, closeMin: 31 * 60 });
  assert.equal(s.eveningCutoffMin, 24 * 60);
  assert.equal(s.notifyHourMax, 22);
  assert.equal(s.staleDeferUntilMin, 22 * 60 + 30, 'min(21:30 + 60, 23:30)');
  assert.deepEqual(s.fallbackNight, { windowStartMin: 24 * 60, windowEndMin: 31 * 60, completeMin: 47 * 60 });
  assert.equal(s.forceChargeMaxRunMs, 8 * H);
  // The bounds of plan date D: D+1 00:00 → 07:00, complete D+1 23:00.
  const b = nightWindowBounds('2026-11-03', s.fallbackNight)!;
  assert.deepEqual(b, { windowStartMs: phx(2026, 11, 4, 0), windowEndMs: phx(2026, 11, 4, 7), scoreSpanEndMs: phx(2026, 11, 4, 23), completeMs: phx(2026, 11, 4, 23) });
});

test('★★ CA15: a cheap window shorter than 3 h still has full nights (no long gap every night)', () => {
  const s = nightScheduleOf(SHORT, DEFAULT_NOTIFY);
  assert.equal(s.fullWindowMinMs, 2 * H);
  const pid = (t: number) => rateAt(SHORT, t).periodId;
  const tonight = resolveCheapWindow(pid, phx(2026, 11, 3, 21, 30), 'super', 30)!;
  assert.deepEqual(tonight, { startMs: phx(2026, 11, 4, 1), endMs: phx(2026, 11, 4, 3) });
  const next = nextFullCheapWindow(pid, tonight.endMs, 'super', 120, s.fullWindowMinMs);
  assert.deepEqual(next, { startMs: phx(2026, 11, 5, 1), endMs: phx(2026, 11, 5, 3) });
  assert.equal(nextFullCheapWindow(pid, tonight.endMs, 'super'), null, 'the APS minimum steps over every 2 h night');
  assert.equal(longGapAhead(tonight, next, s.fullWindowMinMs), false, 'a nightly window is no long gap');
  // The weekly gap rule still holds with the derived minimum.
  assert.equal(longGapAhead(tonight, { startMs: tonight.endMs + 30 * H, endMs: tonight.endMs + 32 * H }, s.fullWindowMinMs), true);
});

test('★★ two-tier with off_peak named: the window is the off-peak span after the on-peak; the evening job moves before it', () => {
  assert.deepEqual(nominalCheapWindow(TWO_TIER_OFF), { periodId: 'off_peak', startHour: 19, lengthHours: 19 });
  const s = nightScheduleOf(TWO_TIER_OFF, DEFAULT_NOTIFY);
  assert.equal(s.eveningCutoffMin, 19 * 60);
  assert.equal(s.notifyHourMax, 18);
  assert.deepEqual(s.notify, { hour: 18, minute: 30, fireMin: 18 * 60 + 30, clampedFrom: { hour: 21, minute: 30 } });
  assert.equal(nightScheduleRepairIssues(s).length, 1, 'the clamp is reported');
  assert.equal(s.forceChargeMaxRunMs, 20 * H);
});

test('★ a midday cheap window opens on the day after the plan date (the night of D is the first window after D 12:00)', () => {
  const s = nightScheduleOf(MIDDAY, DEFAULT_NOTIFY);
  assert.deepEqual(s.window, { openMin: 34 * 60, closeMin: 39 * 60 });
  assert.equal(s.eveningCutoffMin, 24 * 60);
  assert.equal(s.notifyHourMax, 22);
  assert.deepEqual(nightWindowBounds('2026-11-03', s.fallbackNight)!.windowStartMs, phx(2026, 11, 4, 10));
});

test('★★ a plan with no cheap period keeps the APS clock (the planner holds) and says so once at boot', () => {
  const flat = modelWith({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '14' });
  for (const m of [flat, failClosedTariffModel()]) {
    const s = nightScheduleOf(m, DEFAULT_NOTIFY);
    assert.equal(s.source, 'no-cheap-period');
    assert.equal(s.eveningCutoffMin, 23 * 60);
    assert.equal(s.staleDeferUntilMin, NIGHT_PLAN_STALE_DEFER_UNTIL_MIN);
    assert.deepEqual(nightScheduleRepairIssues(s), []);
    assert.match(nightScheduleLogLine(s)!, /no cheap period, so the planner holds every night/);
  }
});

test('nominalCheapWindow: a whole-day period, a wrapped one, and the off-peak tie rule', () => {
  assert.deepEqual(nominalCheapWindow(custom('cheap 0-24 sat-sun all cheap', 'cheap=5; off_peak=15')), { periodId: 'cheap', startHour: 0, lengthHours: 24 });
  assert.deepEqual(nominalCheapWindow(N2206), { periodId: 'night', startHour: 22, lengthHours: 8 });
  // Two equal off-peak runs (03-09 and 15-21): the one opening first after noon.
  const tie = modelWith({ TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'a 09-15 all all onpeak; b 21-03 all all', TARIFF_RATES: 'a=30; b=20; off_peak=10', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak' });
  assert.deepEqual(nominalCheapWindow(tie), { periodId: 'off_peak', startHour: 15, lengthHours: 6 });
  assert.equal(fmtMinuteOfDay(24 * 60), '24:00');
});

test('★★★ W5: the force-charge backstop is the tariff\'s, never the armed window\'s', () => {
  const on = phx(2026, 11, 4, 22, 2);
  const night: NightActuationState = {
    ...emptyActuationState(), day: '2026-11-04', windowStartMs: phx(2026, 11, 4, 22), windowEndMs: phx(2026, 11, 5, 6),
    forceChargeOnAtMs: on, forceChargeSlots: [1, 2, 3], forceChargeCeilingPct: 90, targetPct: 50,
    appliedAtMs: phx(2026, 11, 4, 22), forceChargeVerifiedAtMs: on + 60_000,
  } as NightActuationState;
  const opts = (o: Partial<ForceChargeOpts> = {}): ForceChargeOpts => ({
    enabled: true, gridPresent: true, gridStaLost: false, ceilingReadbackPct: 90, slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3],
    vitalsRed: false, socCoherent: true, poolSocPct: 40, fullKwh: 92.16, ...o,
  });
  const at = on + 7 * H + 60_000;
  assert.equal((decideForceCharge(night, at, opts()) as { reason?: string }).reason, 'maxRun', 'no schedule passed: the fixed 7 h');
  assert.notEqual((decideForceCharge(night, at, opts({ maxRunMs: 9 * H })) as { reason?: string }).reason, 'maxRun', 'the 8 h window\'s 9 h cap');
  assert.equal(forceChargeRunCapMs({ maxRunMs: 1 * H }), FORCE_CHARGE_MAX_RUN_MS, 'never below 7 h');
  assert.equal(forceChargeRunCapMs({ maxRunMs: Number.NaN }), FORCE_CHARGE_MAX_RUN_MS);
  assert.equal(forceChargeRunCapMs({}), FORCE_CHARGE_MAX_RUN_MS);
  // A corrupted 48 h window under the APS schedule still stops at 7 h.
  const corrupt = { ...night, windowEndMs: on + 48 * H };
  assert.equal((decideForceCharge(corrupt, on + 7 * H, opts({ maxRunMs: nightScheduleOf(APS, DEFAULT_NOTIFY).forceChargeMaxRunMs })) as { reason?: string }).reason, 'maxRun');
});

test('★ the readiness diagnostic counts a night complete at the schedule\'s offset (45 h by default)', () => {
  // Five scored nights, plan dates 11-04..11-08, read at 11-10 22:00: with the APS 45 h the latest
  // complete date is 11-09 (six expected, one missing); with a 47 h night it is 11-08 (none missing).
  const now = phx(2026, 11, 10, 22, 0);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    plan_date: `2026-11-0${i + 4}`, algo_version: String(CURRENT_ALGO_VERSION), outcome_captured_at_ms: now - (6 - i) * 24 * H, scored: 1,
  })) as unknown as Parameters<typeof computeNightChargeReadiness>[0];
  const ex = (o?: { completeAfterMs?: number }) => computeNightChargeReadiness(rows, now, o).metrics.exclusionFrac;
  assert.equal(ex(), 0.167);
  assert.equal(ex({ completeAfterMs: 45 * H }), 0.167);
  assert.equal(ex({ completeAfterMs: 47 * H }), 0);
});

test('★★ wiring: every evening-job reader takes the schedule', () => {
  const idx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const job = idx.slice(idx.indexOf('async function runNightChargeEveningJobInner('), idx.indexOf('\n}\n', idx.indexOf('async function runNightChargeEveningJobInner(')));
  assert.ok(job.includes('  const sched = nightScheduleNow();\n  const fireMin = sched.notify.fireMin;\n  const cutoffMin = sched.eveningCutoffMin;'));
  assert.ok(job.includes('  const deferUntilMin = sched.staleDeferUntilMin;'));
  assert.ok(job.includes('eveningBasisDefers(fresh?.plan ?? null, nowMin, deferUntilMin)'));
  assert.ok(!job.includes('23 * 60') && !job.includes('NIGHT_PLAN_STALE_DEFER_UNTIL_MIN') && !job.includes('NIGHT_CHARGE_NOTIFY_HOUR'),
    'no APS constant left in the evening job');
  assert.ok(idx.includes('nowMin >= fireMin && nowMin < sched.eveningCutoffMin) {'), 'the shadow tick');
  assert.ok(idx.includes('const b = nightWindowBounds(String(y.plan_date), nightScheduleNow().fallbackNight);'), 'the scorer');
  assert.ok(idx.includes('notifyMinuteOfDay: nightSched.notify.fireMin,'), 'the plan snapshot');
  assert.ok(idx.includes('notify: { hour: nightSchedNotify.hour, minute: nightSchedNotify.minute, lastNotifyDay: latch.lastNotifyDay },'), 'the status route');
  assert.equal(idx.split('maxRunMs: forceChargeMaxRunNow(),').length - 1, 4, 'every decideForceCharge call');
  assert.ok(idx.includes('  try { return nightScheduleNow().forceChargeMaxRunMs; } catch { return FORCE_CHARGE_MAX_RUN_MS; }'),
    'the OFF decision never waits on a tariff read that fails');
  assert.equal(idx.split('decideForceCharge(').length - 1, 4);
  assert.equal(idx.split('nightReadinessOpts()').length - 1, 5, 'every readiness recompute (four) and the definition');
  assert.ok(idx.includes('report.issues.push(...nightScheduleRepairIssues(nightScheduleNow(), report.generatedAt));'));
  assert.ok(idx.includes('function nightScheduleNow(model = tariffModelFromEnv()): NightSchedule {\n  return nightScheduleOf(model, { hour: NIGHT_CHARGE_NOTIFY_HOUR, minute: NIGHT_CHARGE_NOTIFY_MINUTE });'));
  // eveningBasisDefers keeps the APS end when it is not given one.
  assert.equal(eveningBasisDefers(null, 22 * 60 + 29), true);
  assert.equal(eveningBasisDefers(null, 22 * 60 + 30), false);
  assert.equal(eveningBasisDefers(null, 21 * 60 + 45, 21 * 60 + 30), false);
});
