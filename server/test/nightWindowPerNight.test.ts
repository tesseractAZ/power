import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tariffModelFromEnv, cheapPeriodIdOf, rateAt, type TariffModel } from '../src/tariff.js';
import {
  chooseChargeCycle, nextChargeableOpenMs, resolveCheapWindow, cheapNightOf, OVERNIGHT_CYCLE,
} from '../src/chargeWindows.js';
import { nightScheduleOf } from '../src/nightSchedule.js';
import { buildNightChargeInputs, computeNightChargePlan, OVERNIGHT_WINDOW_SPEC, nextFullCheapWindow, type NightChargeInputDeps } from '../src/nightChargeAdvisor.js';
import { armRefusalReason, emptyActuationState } from '../src/nightChargeActuator.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';

/**
 * v1.191.0 (review) — A NIGHT'S CHARGE WINDOW IS ONE NIGHT OF THE CHEAP PERIOD.
 *
 * The guide tells a home with a two-period tariff to use `two_tier` with NIGHT_CHARGE_CHEAP_PERIOD
 * `off_peak`. With the on-peak period on Mon–Fri only, the whole weekend is one off-peak run, Friday
 * 19:00 to Monday 14:00, and the resolver treated it as one window:
 *  - Friday's window ended Saturday 20:00 (the run end is looked for 24 h out);
 *  - Saturday's and Sunday's plans started inside the run and walked back to its start (or 30 h,
 *    the scan cap): Friday 19:00 → Sunday 19:00, Saturday 12:00 → Monday 14:00;
 *  - a write mode refuses a window that opened more than 30 minutes earlier
 *    (nightChargeActuator.ts armRefusalReason), so nothing charged on Saturday or Sunday, and
 *    Monday's on-peak began on what was left of Friday's charge.
 * The window is now bounded to the plan's nominal cheap window (chargeWindows.ts cheapNightOf): each
 * evening plans its own night, and the next window opens the next evening. The APS R-EV preset has
 * no bound (its runs never exceed a night): the reference install is unchanged (golden G4).
 *
 * The plans run on the site clock of the test process (America/Phoenix, fixed UTC−7); the
 * daylight-saving cases put the same model on America/New_York.
 */

const H = 3_600_000;
const MIN = 60_000;
const phx = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h + 7, min);
const TARIFF_KEYS = [
  'TARIFF_PLAN', 'TARIFF_PERIODS', 'TARIFF_RATES', 'TARIFF_RATES_CONFIRMED', 'NIGHT_CHARGE_CHEAP_PERIOD',
  'TARIFF_ON_PEAK_HOURS', 'TARIFF_ON_PEAK_DAYS', 'TARIFF_ON_PEAK_CENTS', 'TARIFF_OFF_PEAK_CENTS',
  'TARIFF_FLAT_CENTS_PER_KWH', 'TARIFF_SUMMER_MONTHS', 'TARIFF_HOLIDAYS',
];
function modelWith(patch: Record<string, string>): TariffModel {
  const saved = new Map(TARIFF_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TARIFF_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return tariffModelFromEnv(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const pidOf = (m: TariffModel) => (t: number): string => rateAt(m, t).periodId;
/** What index.ts resolves for the evening plan (its resolver call, with the model's night bound). */
const indexWindow = (m: TariffModel, at: number) => resolveCheapWindow(pidOf(m), at, cheapPeriodIdOf(m)!, 30, cheapNightOf(m));
/** What a write mode decides for a window planned at `at` (a plan that calls for a charge). */
const armVerdict = (w: { startMs: number; endMs: number }, at: number) => armRefusalReason(
  emptyActuationState(),
  { chargeTonight: true, basisComplete: true, window: w, setpointSocPct: 40, buyKwh: 5 } as Parameters<typeof armRefusalReason>[1],
  at, null,
);

/** The finding's setup: on-peak 14–19 Mon–Fri, off-peak named the night-charge period. */
const TWO_TIER_OFF = modelWith({
  TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19', TARIFF_ON_PEAK_DAYS: '1-5',
  TARIFF_ON_PEAK_CENTS: '38', TARIFF_OFF_PEAK_CENTS: '12', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak',
});
/** The finding's custom plan: on-peak 08–24 Mon–Fri, off-peak named the night-charge period. */
const CUSTOM_OFF = modelWith({
  TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'on_peak 08-24 mon-fri all onpeak', TARIFF_RATES: 'on_peak=31; off_peak=9',
  TARIFF_RATES_CONFIRMED: 'true', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak', TARIFF_HOLIDAYS: 'none',
});
const APS = modelWith({});

// 2026-11-05 is a Thursday; 11-06 Friday, 11-07 Saturday, 11-08 Sunday, 11-09 Monday.
const EVENINGS: Array<[string, number]> = [['Thu', 5], ['Fri', 6], ['Sat', 7], ['Sun', 8]];

test('precondition: the two-tier plan plans at 18:30, before its 19:00 window (S6 clamp)', () => {
  const s = nightScheduleOf(TWO_TIER_OFF, { hour: 21, minute: 30 });
  assert.deepEqual({ hour: s.notify.hour, minute: s.notify.minute }, { hour: 18, minute: 30 });
  assert.deepEqual(s.window, { openMin: 19 * 60, closeMin: (24 + 14) * 60 });
  const night = cheapNightOf(TWO_TIER_OFF)!;
  assert.equal(night.lengthHours, 19);
  assert.equal(night.nightHourAt(phx(2026, 11, 7, 19)), 0, 'the night opens at 19:00');
  assert.equal(night.nightHourAt(phx(2026, 11, 8, 13)), 18, 'its last hour is 13:00');
  assert.equal(night.nightHourAt(phx(2026, 11, 8, 14)), 19, '14:00 lies outside every night');
});

test('★★★ every evening of the weekend plans its own night, opening after the plan, and a write mode arms it', () => {
  for (const [day, d] of EVENINGS) {
    const at = phx(2026, 11, d, 18, 30);
    const want = { startMs: phx(2026, 11, d, 19), endMs: phx(2026, 11, d + 1, 14) };
    const cyc = chooseChargeCycle(TWO_TIER_OFF, at, OVERNIGHT_CYCLE).cost!;
    assert.deepEqual({ startMs: cyc.startMs, endMs: cyc.endMs }, want, `${day}: the cycle chooser`);
    assert.deepEqual(indexWindow(TWO_TIER_OFF, at), want, `${day}: index.ts's resolver call`);
    assert.equal(armVerdict(want, at), null, `${day}: the window is armed`);
  }
});

test('★★★ without the bound the weekend is one window (the finding, reproduced at the resolver)', () => {
  const pid = pidOf(TWO_TIER_OFF);
  const fri = resolveCheapWindow(pid, phx(2026, 11, 6, 18, 30), 'off_peak', 30)!;
  assert.deepEqual(fri, { startMs: phx(2026, 11, 6, 19), endMs: phx(2026, 11, 7, 20) }, 'Friday ends Saturday 20:00');
  const sat = resolveCheapWindow(pid, phx(2026, 11, 7, 18, 30), 'off_peak', 30)!;
  assert.equal(sat.startMs, phx(2026, 11, 6, 19), 'Saturday walks back to Friday 19:00');
  assert.match(armVerdict(sat, phx(2026, 11, 7, 18, 30)) ?? '', /opened more than 30 minutes ago/);
  const sun = resolveCheapWindow(pid, phx(2026, 11, 8, 18, 30), 'off_peak', 30)!;
  assert.equal(sun.startMs, phx(2026, 11, 7, 12), 'Sunday walks back 30 h (the scan cap)');
  assert.match(armVerdict(sun, phx(2026, 11, 8, 18, 30)) ?? '', /opened more than 30 minutes ago/);
});

test('★★★ the horizon end is the next evening\'s window, never the window in progress', () => {
  for (const [day, d] of EVENINGS) {
    const w = indexWindow(TWO_TIER_OFF, phx(2026, 11, d, 18, 30))!;
    assert.equal(nextChargeableOpenMs(TWO_TIER_OFF, w.endMs + H), phx(2026, 11, d + 1, 19), `${day}: the next night opens the next evening`);
  }
  // The long-gap scan steps night by night: Friday's next full window is Saturday's.
  const fri = indexWindow(TWO_TIER_OFF, phx(2026, 11, 6, 18, 30))!;
  assert.deepEqual(nextFullCheapWindow(pidOf(TWO_TIER_OFF), fri.endMs, 'off_peak', 120, 3 * H, cheapNightOf(TWO_TIER_OFF)),
    { startMs: phx(2026, 11, 7, 19), endMs: phx(2026, 11, 8, 14) });
});

test('★★ a recompute inside a weekend night walks back to that night\'s open, not to Friday', () => {
  assert.deepEqual(indexWindow(TWO_TIER_OFF, phx(2026, 11, 8, 1, 10)), { startMs: phx(2026, 11, 7, 19), endMs: phx(2026, 11, 8, 14) });
  // Between two nights (Sunday 15:00, off-peak but outside the nominal window) the next night is ahead.
  assert.deepEqual(indexWindow(TWO_TIER_OFF, phx(2026, 11, 8, 15)), { startMs: phx(2026, 11, 8, 19), endMs: phx(2026, 11, 9, 14) });
});

test('★★★ the custom plan: each weekend evening plans 00:00–08:00 of the next day', () => {
  for (const [day, d] of [['Fri', 6], ['Sat', 7], ['Sun', 8]] as const) {
    const at = phx(2026, 11, d, 21, 30);
    const want = { startMs: phx(2026, 11, d + 1, 0), endMs: phx(2026, 11, d + 1, 8) };
    const cyc = chooseChargeCycle(CUSTOM_OFF, at, OVERNIGHT_CYCLE).cost!;
    assert.deepEqual({ startMs: cyc.startMs, endMs: cyc.endMs }, want, `${day}: the cycle chooser`);
    assert.deepEqual(indexWindow(CUSTOM_OFF, at), want, `${day}: index.ts's resolver call`);
    assert.equal(armVerdict(want, at), null, `${day}: armed`);
  }
});

/** The '2026-10-12 cost' fixture night (index.ts's inputs on a Monday 21:30), re-timed to `m`. */
const FIXTURE_NIGHT = legacyIdentityCases().find((x) => x.label === '2026-10-12 cost')!.deps;

test('★★★ the planner sizes the bounded night: the deps carry the bound to the sizer', () => {
  // On-peak Tue–Sat only: Monday's off-peak runs from Saturday 22:00 to Tuesday 12:00. The nominal
  // window is 22:00–12:00, so the Monday 21:30 plan's window is Monday 22:00 → Tuesday 12:00.
  const m = modelWith({
    TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'on_peak 12-22 tue-sat all onpeak', TARIFF_RATES: 'on_peak=30; off_peak=10',
    TARIFF_RATES_CONFIRMED: 'true', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak', TARIFF_HOLIDAYS: 'none',
  });
  const deps = (bound: boolean): NightChargeInputDeps => ({
    ...FIXTURE_NIGHT, periodIdAt: pidOf(m), cheapPeriodId: 'off_peak', windowSpec: OVERNIGHT_WINDOW_SPEC,
    cheapNight: bound ? cheapNightOf(m) : null,
  });
  const nowMs = FIXTURE_NIGHT.nowMs;
  const live = computeNightChargePlan(buildNightChargeInputs(deps(true)));
  assert.deepEqual(live.window, { startMs: phx(2026, 10, 12, 22), endMs: phx(2026, 10, 13, 12) });
  assert.equal(live.basisComplete, true);
  assert.equal(live.chargeTonight, true, `a buy is sized (got ${live.buyKwh})`);
  assert.equal(armRefusalReason(emptyActuationState(), live, nowMs, null), null, 'a write mode arms it');
  // Without the bound the sizer resolves the run in progress, 30 h back, and the arm is refused.
  const unbounded = computeNightChargePlan(buildNightChargeInputs(deps(false)));
  assert.equal(unbounded.window!.startMs, nowMs - 30 * H - 30 * MIN);
  assert.match(armRefusalReason(emptyActuationState(), { ...unbounded, chargeTonight: true, basisComplete: true, buyKwh: 5, setpointSocPct: 40 }, nowMs, null) ?? '',
    /opened more than 30 minutes ago/);
});

test('★★ daylight-saving changes stay inside one night; a whole-day window is one local day', () => {
  const ny = { ...TWO_TIER_OFF, timezone: 'America/New_York' };
  const at = (y: number, mo: number, d: number, h: number, min: number, offsetH: number) => Date.UTC(y, mo - 1, d, h + offsetH, min);
  // Spring forward (2026-03-08 02:00): Saturday 19:00 EST → Sunday 14:00 EDT, 18 real hours.
  const spring = indexWindow(ny, at(2026, 3, 7, 18, 30, 5))!;
  assert.deepEqual(spring, { startMs: at(2026, 3, 7, 19, 0, 5), endMs: at(2026, 3, 8, 14, 0, 4) });
  assert.equal((spring.endMs - spring.startMs) / H, 18);
  // Fall back (2026-11-01 02:00): Saturday 19:00 EDT → Sunday 14:00 EST, 20 real hours (the repeated 01:00 stays in).
  const fall = indexWindow(ny, at(2026, 10, 31, 18, 30, 4))!;
  assert.deepEqual(fall, { startMs: at(2026, 10, 31, 19, 0, 4), endMs: at(2026, 11, 1, 14, 0, 5) });
  assert.equal((fall.endMs - fall.startMs) / H, 20);
  // A cheap period that covers the whole day: each night is one local day, 23 or 25 hours across a change.
  const allDay = { ...modelWith({ TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'cheap 00-24 all all cheap', TARIFF_RATES: 'cheap=9; off_peak=20', TARIFF_HOLIDAYS: 'none' }), timezone: 'America/New_York' };
  assert.equal(cheapNightOf(allDay)!.lengthHours, 24);
  const short = indexWindow(allDay, at(2026, 3, 7, 21, 30, 5))!;
  assert.deepEqual(short, { startMs: at(2026, 3, 7, 0, 0, 5), endMs: at(2026, 3, 8, 0, 0, 5) }, 'inside the run: back to this local midnight');
  const next = resolveCheapWindow(pidOf(allDay), short.endMs, 'cheap', 30, cheapNightOf(allDay))!;
  assert.equal((next.endMs - next.startMs) / H, 23, 'the spring-forward day');
  const longDay = resolveCheapWindow(pidOf(allDay), at(2026, 11, 1, 0, 0, 4), 'cheap', 30, cheapNightOf(allDay))!;
  assert.equal((longDay.endMs - longDay.startMs) / H, 25, 'the fall-back day');
});

test('★★★ the APS R-EV preset and a plan with no cheap period have no bound (the reference install is unchanged)', () => {
  assert.equal(cheapNightOf(APS), null);
  assert.equal(cheapNightOf(modelWith({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '14' })), null);
  assert.equal(cheapNightOf(modelWith({ TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19' })), null, 'two_tier without NIGHT_CHARGE_CHEAP_PERIOD');
  // The APS preset planning another period is a derived schedule, so it is bounded like any other plan.
  assert.notEqual(cheapNightOf(modelWith({ NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak' })), null);
  // A year of APS evenings: the chooser equals the unbounded resolver (the G4 golden pins the values).
  const pid = pidOf(APS);
  for (let d = 0; d < 366; d++) {
    const at = phx(2026, 1, 1, 21, 30) + d * 24 * H;
    const cyc = chooseChargeCycle(APS, at, OVERNIGHT_CYCLE).cost;
    const w = resolveCheapWindow(pid, at, 'overnight', 30);
    assert.deepEqual(cyc && { startMs: cyc.startMs, endMs: cyc.endMs }, w, `day ${d}`);
  }
});
