import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseChargeCycle, nextChargeableOpenMs, planDateOwningCycle, seasonGraceActive, superOffPeakRateVeto,
  middayConfigGate, middayRunVeto, legObjective, legForceChargeEligible,
  CHARGE_CYCLE_SCAN_HOURS, NEXT_CHARGEABLE_SCAN_HOURS, SEASON_GRACE_DAYS, MIDDAY_MIN_COST_MAX_SOC_PCT,
  OVERNIGHT_CYCLE, WINDOW_PERIOD_ID,
  type ChargeCycleConfig, type ChargeCycle,
} from '../src/chargeWindows.js';
import { buildApsREvModel, apsOffPeakHolidays, APS_PERIOD, rateAt, type TariffModel } from '../src/tariff.js';
import { RESERVE_WRITE_MAX_PCT } from '../src/nightChargeActuator.js';

/**
 * R2 — THE WINDOW CHOOSER (chargeWindows.ts). Which windows a charge cycle uses: the overnight
 * window carries the cost buy as it always has, or — winter weekdays, configured for it — the
 * super off-peak window (10:00–15:00) carries it and the overnight window before it becomes a
 * resilience-only backup. Checked against an INDEPENDENT calendar (weekday, the R-EV holiday
 * list, the usage-month season, the October grace), not against rateAt.
 */

const H = 3_600_000;
const MODEL = buildApsREvModel();
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h + 7, mi);
const MIDDAY: ChargeCycleConfig = { costWindow: 'super_off_peak', objective: 'cost', costMaxSocPct: 90 };
const iso = (ms: number | null | undefined): string => (ms == null ? String(ms) : new Date(ms - 7 * H).toISOString().slice(0, 16));
const legsText = (c: ChargeCycle): string => c.legs.map((l) => `${l.role}:${l.kind} ${iso(l.startMs)}..${iso(l.endMs)}`).join(' | ');

/* ── the independent calendar ── */
const HOLIDAYS = new Set([2025, 2026, 2027, 2028].flatMap((y) => apsOffPeakHolidays(y)));
const ymdOf = (y: number, mo: number, d: number): string => new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10);
/** Mon–Fri and not an R-EV holiday: the days that have overnight and super off-peak hours. */
const tariffDay = (y: number, mo: number, d: number): boolean => {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5 && !HOLIDAYS.has(ymdOf(y, mo, d));
};
const winterUsage = (mo: number): boolean => mo >= 10 || mo <= 3;
const addDays = (y: number, mo: number, d: number, n: number): [number, number, number] => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};
/** The legs a 21:30 plan on (y, mo, d) arms, by the calendar alone. */
function expectedLegs(y: number, mo: number, d: number, cfg: 'midday' | 'overnight'): string {
  const d1 = addDays(y, mo, d, 1);
  const d2 = addDays(y, mo, d, 2);
  // The overnight run the 30 h scan finds from 21:30 (21:00 → 03:00 two days on).
  let run: [number, number] | null = null;
  if (tariffDay(y, mo, d)) run = [phx(y, mo, d, 23), tariffDay(...d1) ? phx(...d1, 5) : phx(...d1, 0)];
  else if (tariffDay(...d1)) run = [phx(...d1, 0), phx(...d1, 5)];
  else if (tariffDay(...d2)) run = [phx(...d2, 0), phx(...d2, 5)];
  const midday = cfg === 'midday' && tariffDay(...d1) && winterUsage(d1[1]) && !(d1[1] === 10 && d1[2] <= 7);
  if (midday) {
    const backup = `backup:overnight ${iso(run![0])}..${iso(run![1])}`;
    return `${backup} | cost:super_off_peak ${iso(phx(...d1, 10))}..${iso(phx(...d1, 15))}`;
  }
  return run ? `cost:overnight ${iso(run[0])}..${iso(run[1])}` : '';
}

test('the constants', () => {
  assert.equal(CHARGE_CYCLE_SCAN_HOURS, 30);
  assert.equal(NEXT_CHARGEABLE_SCAN_HOURS, 96);
  assert.equal(SEASON_GRACE_DAYS, 7);
  assert.equal(MIDDAY_MIN_COST_MAX_SOC_PCT, RESERVE_WRITE_MAX_PCT, 'a mid-day buy needs a ceiling above the reserve write');
  assert.deepEqual(WINDOW_PERIOD_ID, { overnight: 'overnight', super_off_peak: 'super_off_peak' });
});

test('★★ APS_PERIOD names the model\'s own period ids', () => {
  assert.deepEqual(APS_PERIOD, { ON_PEAK: 'on_peak', SUPER_OFF_PEAK: 'super_off_peak', OVERNIGHT: 'overnight', OFF_PEAK: 'off_peak' });
  assert.deepEqual(MODEL.periods.map((p) => p.id), [APS_PERIOD.ON_PEAK, APS_PERIOD.SUPER_OFF_PEAK, APS_PERIOD.OVERNIGHT]);
  assert.equal(MODEL.offPeak.id, APS_PERIOD.OFF_PEAK);
  assert.equal(rateAt(MODEL, phx(2026, 11, 3, 11)).periodId, APS_PERIOD.SUPER_OFF_PEAK);
  assert.equal(rateAt(MODEL, phx(2026, 11, 3, 23)).periodId, APS_PERIOD.OVERNIGHT);
  assert.ok(Object.isFrozen(APS_PERIOD));
});

test('★★★ every evening of the 2026-27 winter: the legs the calendar gives (the plan table)', () => {
  let midday = 0, overnight = 0;
  for (let t = Date.UTC(2026, 8, 25); t <= Date.UTC(2027, 3, 5); t += 86_400_000) {
    const day = new Date(t);
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const c = chooseChargeCycle(MODEL, phx(y, mo, d, 21, 30), MIDDAY);
    assert.equal(legsText(c), expectedLegs(y, mo, d, 'midday'), `${ymdOf(y, mo, d)} (${c.why})`);
    if (c.why === 'midday') midday++; else overnight++;
    // Under the overnight cycle the same evening is today's single leg.
    assert.equal(legsText(chooseChargeCycle(MODEL, phx(y, mo, d, 21, 30), OVERNIGHT_CYCLE)), expectedLegs(y, mo, d, 'overnight'));
  }
  assert.ok(midday > 100 && overnight > 60, `${midday} mid-day, ${overnight} overnight`);
});

test('★★★ the table: Sun → backup Mon 00–05 + cost Mon 10–15; Mon–Thu → backup 23–05 + cost next 10–15; Fri, Sat → overnight', () => {
  // The week of 2026-11-01 (Sun) .. 11-07 (Sat).
  const at = (d: number) => chooseChargeCycle(MODEL, phx(2026, 11, d, 21, 30), MIDDAY);
  assert.equal(legsText(at(1)), 'backup:overnight 2026-11-02T00:00..2026-11-02T05:00 | cost:super_off_peak 2026-11-02T10:00..2026-11-02T15:00');
  for (const d of [2, 3, 4, 5]) {
    const c = at(d);
    assert.equal(c.why, 'midday');
    assert.equal(legsText(c), `backup:overnight 2026-11-0${d}T23:00..2026-11-0${d + 1}T05:00 | cost:super_off_peak 2026-11-0${d + 1}T10:00..2026-11-0${d + 1}T15:00`);
    assert.equal(c.backup, c.legs[0]);
    assert.equal(c.cost, c.legs[1]);
  }
  const fri = at(6);
  assert.equal(fri.why, 'no-run-in-scan');
  assert.equal(legsText(fri), 'cost:overnight 2026-11-06T23:00..2026-11-07T00:00', "Friday's one-hour overnight, as today");
  const sat = at(7);
  assert.equal(sat.why, 'no-run-in-scan');
  assert.equal(legsText(sat), 'cost:overnight 2026-11-09T00:00..2026-11-09T05:00');
});

test('★★★ the 30 h scan is what keeps Friday and Saturday on overnight', () => {
  // Saturday 21:30 → Monday 10:00 is 36.5 h; Friday's is 60.5 h.
  const sat = phx(2026, 11, 7, 21, 30);
  assert.equal(chooseChargeCycle(MODEL, sat, MIDDAY).why, 'no-run-in-scan');
  const wide = chooseChargeCycle(MODEL, sat, MIDDAY, 40);
  assert.equal(wide.why, 'midday', 'a 40 h scan would move the weekend charge to Monday mid-day');
  assert.equal(iso(wide.cost!.startMs), '2026-11-09T10:00');
  assert.equal(chooseChargeCycle(MODEL, phx(2026, 11, 6, 21, 30), MIDDAY, 61).why, 'midday');
  // Sunday's 12.5 h is inside it.
  assert.equal(chooseChargeCycle(MODEL, phx(2026, 11, 8, 21, 30), MIDDAY).why, 'midday');
});

test('★★★ the 2026-27 holidays: the eve of an off-peak day keeps the overnight cycle', () => {
  const at = (y: number, mo: number, d: number) => chooseChargeCycle(MODEL, phx(y, mo, d, 21, 30), MIDDAY);
  // Columbus Day Mon 10-12 is off-peak all day, its 23:00 hour included: Sunday's evening plans
  // Tuesday 00:00.
  assert.equal(legsText(at(2026, 10, 11)), 'cost:overnight 2026-10-13T00:00..2026-10-13T05:00');
  assert.equal(at(2026, 10, 12).why, 'midday', 'the evening OF the holiday plans Tuesday mid-day');
  assert.equal(legsText(at(2026, 10, 12)), 'backup:overnight 2026-10-13T00:00..2026-10-13T05:00 | cost:super_off_peak 2026-10-13T10:00..2026-10-13T15:00');
  // Veterans Day Wed 11-11.
  assert.equal(legsText(at(2026, 11, 10)), 'cost:overnight 2026-11-10T23:00..2026-11-11T00:00');
  // Thanksgiving Thu 11-26.
  assert.equal(legsText(at(2026, 11, 25)), 'cost:overnight 2026-11-25T23:00..2026-11-26T00:00');
  assert.equal(legsText(at(2026, 11, 26)), 'backup:overnight 2026-11-27T00:00..2026-11-27T05:00 | cost:super_off_peak 2026-11-27T10:00..2026-11-27T15:00');
  // Christmas Eve Thu, Christmas Fri, the weekend: Wednesday's one hour, then nothing for days.
  assert.equal(legsText(at(2026, 12, 23)), 'cost:overnight 2026-12-23T23:00..2026-12-24T00:00');
  const xmasEve = at(2026, 12, 24);
  assert.equal(xmasEve.why, 'no-run-in-scan');
  assert.equal(xmasEve.cost, null, 'no overnight window within the scan either');
  assert.deepEqual(xmasEve.legs, []);
  // New Year's Eve Thu, New Year's Day Fri.
  assert.equal(legsText(at(2026, 12, 30)), 'cost:overnight 2026-12-30T23:00..2026-12-31T00:00');
  // MLK Mon 2027-01-18 and Presidents Day Mon 2027-02-15.
  assert.equal(legsText(at(2027, 1, 17)), 'cost:overnight 2027-01-19T00:00..2027-01-19T05:00');
  assert.equal(legsText(at(2027, 2, 14)), 'cost:overnight 2027-02-16T00:00..2027-02-16T05:00');
  assert.equal(at(2027, 2, 15).why, 'midday');
});

test('★★★ Mar 30 – Apr 1 2027: the last mid-day, Cesar Chavez Day, the first summer day', () => {
  const at = (mo: number, d: number) => chooseChargeCycle(MODEL, phx(2027, mo, d, 21, 30), MIDDAY);
  assert.equal(legsText(at(3, 29)), 'backup:overnight 2027-03-29T23:00..2027-03-30T05:00 | cost:super_off_peak 2027-03-30T10:00..2027-03-30T15:00');
  // Wed 03-31 is a holiday; Thu 04-01 is summer (no super off-peak).
  assert.equal(legsText(at(3, 30)), 'cost:overnight 2027-03-30T23:00..2027-03-31T00:00');
  assert.equal(legsText(at(3, 31)), 'cost:overnight 2027-04-01T00:00..2027-04-01T05:00');
  assert.equal(at(4, 1).why, 'no-run-in-scan');
});

test('★★★ summer keeps the overnight cycle every evening', () => {
  for (let t = Date.UTC(2027, 3, 1); t < Date.UTC(2027, 9, 1); t += 86_400_000) {
    const day = new Date(t);
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const c = chooseChargeCycle(MODEL, phx(y, mo, d, 21, 30), MIDDAY);
    assert.notEqual(c.why, 'midday', ymdOf(y, mo, d));
    assert.equal(c.backup, null);
    assert.equal(legsText(c), expectedLegs(y, mo, d, 'overnight'), ymdOf(y, mo, d));
  }
});

test('★★★ the October grace: Oct 1–7 stay overnight, Oct 8 is the first mid-day', () => {
  const at = (mo: number, d: number, cfg = MIDDAY) => chooseChargeCycle(MODEL, phx(2026, mo, d, 21, 30), cfg);
  assert.equal(at(9, 30).why, 'season-grace', 'Wed 09-30 → Thu 10-01');
  assert.equal(legsText(at(9, 30)), 'cost:overnight 2026-09-30T23:00..2026-10-01T05:00');
  assert.equal(at(10, 6).why, 'season-grace', 'Tue → Wed 10-07');
  assert.equal(at(10, 7).why, 'midday', 'Wed → Thu 10-08');
  assert.equal(iso(at(10, 7).cost!.startMs), '2026-10-08T10:00');
  // A grace of 0 days: October 1 is mid-day.
  assert.equal(at(9, 30, { ...MIDDAY, seasonGraceDays: 0 }).why, 'midday');
  assert.equal(at(10, 6, { ...MIDDAY, seasonGraceDays: 6 }).why, 'midday');
});

test('★★ seasonGraceActive: the first 7 days of the first winter month only', () => {
  assert.equal(seasonGraceActive(MODEL, phx(2026, 10, 1, 0)), true);
  assert.equal(seasonGraceActive(MODEL, phx(2026, 10, 7, 23, 59)), true);
  assert.equal(seasonGraceActive(MODEL, phx(2026, 10, 8, 0)), false);
  assert.equal(seasonGraceActive(MODEL, phx(2026, 9, 30, 12)), false, 'summer');
  assert.equal(seasonGraceActive(MODEL, phx(2026, 11, 2, 10)), false, 'November follows a winter month');
  assert.equal(seasonGraceActive(MODEL, phx(2027, 1, 4, 10)), false);
  assert.equal(seasonGraceActive(MODEL, phx(2027, 4, 1, 10)), false, 'the turn into summer has no grace');
  assert.equal(seasonGraceActive(MODEL, phx(2026, 10, 3, 10), 0), false);
  assert.equal(seasonGraceActive(MODEL, phx(2026, 10, 3, 10), Number.NaN), false);
  // A model with no summer months has no turn, so no grace.
  assert.equal(seasonGraceActive({ timezone: 'America/Phoenix', summerMonths: [] }, phx(2026, 10, 3, 10)), false);
  assert.equal(seasonGraceActive({ timezone: 'America/Phoenix', summerMonths: [5, 6, 7, 8, 9, 10] }, phx(2026, 11, 3, 10)), true,
    'the first winter month follows the model, not the calendar');
});

test('★★★ the rate veto: only confirmed rates with super off-peak at or above overnight', () => {
  const withRates = (sop: number | null, overnight: number | null, confirmed = true): TariffModel => buildApsREvModel({
    overnight: { summer: overnight, winter: overnight },
    superOffPeak: { summer: null, winter: sop },
    confirmed,
  });
  const tue = phx(2026, 11, 2, 21, 30);
  const wed10 = phx(2026, 11, 4, 10);
  assert.equal(chooseChargeCycle(withRates(8.2, 12.59), tue, MIDDAY).why, 'midday');
  assert.equal(chooseChargeCycle(withRates(12.59, 12.59), tue, MIDDAY).why, 'rate-veto', 'equal is no saving');
  assert.equal(chooseChargeCycle(withRates(13, 12.59), tue, MIDDAY).why, 'rate-veto');
  assert.equal(legsText(chooseChargeCycle(withRates(13, 12.59), tue, MIDDAY)), 'cost:overnight 2026-11-02T23:00..2026-11-03T05:00');
  assert.equal(chooseChargeCycle(withRates(13, 12.59, false), tue, MIDDAY).why, 'midday', 'unconfirmed rates never veto');
  assert.equal(chooseChargeCycle(withRates(null, 12.59), tue, MIDDAY).why, 'midday', 'a missing rate never vetoes');
  assert.equal(chooseChargeCycle(withRates(13, null), tue, MIDDAY).why, 'midday');
  assert.equal(superOffPeakRateVeto(withRates(13, 12.59), wed10), true);
  assert.equal(superOffPeakRateVeto(withRates(13, 12.59), phx(2026, 11, 4, 16)), false, 'not a super off-peak instant');
  assert.equal(middayRunVeto(withRates(13, 12.59), wed10, MIDDAY), 'rate-veto');
  assert.equal(middayRunVeto(MODEL, phx(2026, 10, 2, 10), MIDDAY), 'season-grace');
  assert.equal(middayRunVeto(MODEL, wed10, MIDDAY), null);
});

test('★★★ the configuration asks first: window, objective, a ceiling above the reserve write', () => {
  const tue = phx(2026, 11, 2, 21, 30);
  assert.equal(middayConfigGate(OVERNIGHT_CYCLE), 'overnight-configured');
  assert.equal(middayConfigGate({ ...MIDDAY, costWindow: 'overnight' }), 'overnight-configured');
  assert.equal(middayConfigGate({ ...MIDDAY, objective: 'resilience' }), 'not-cost-objective');
  assert.equal(middayConfigGate({ ...MIDDAY, costMaxSocPct: 50 }), 'ceiling-at-reserve');
  assert.equal(middayConfigGate({ ...MIDDAY, costMaxSocPct: Number.NaN }), 'ceiling-at-reserve');
  assert.equal(middayConfigGate({ ...MIDDAY, costMaxSocPct: 51 }), null);
  for (const cfg of [OVERNIGHT_CYCLE, { ...MIDDAY, objective: 'resilience' as const }, { ...MIDDAY, costMaxSocPct: 50 }]) {
    const c = chooseChargeCycle(MODEL, tue, cfg);
    assert.equal(legsText(c), 'cost:overnight 2026-11-02T23:00..2026-11-03T05:00');
    assert.equal(c.backup, null);
  }
});

test('★★★ a plan made after the overnight run has no backup; one made inside the mid-day run finds it', () => {
  const at = (h: number, mi = 0) => chooseChargeCycle(MODEL, phx(2026, 11, 3, h, mi), MIDDAY);
  assert.equal(legsText(at(6)), 'cost:super_off_peak 2026-11-03T10:00..2026-11-03T15:00', 'Tue 06:00: the backup is behind it');
  assert.equal(legsText(at(11, 20)), 'cost:super_off_peak 2026-11-03T10:00..2026-11-03T15:00', 'mid-window: the run in progress');
  assert.equal(legsText(at(16)), 'backup:overnight 2026-11-03T23:00..2026-11-04T05:00 | cost:super_off_peak 2026-11-04T10:00..2026-11-04T15:00');
  assert.equal(legsText(at(23, 30)), 'backup:overnight 2026-11-03T23:00..2026-11-04T05:00 | cost:super_off_peak 2026-11-04T10:00..2026-11-04T15:00',
    'inside the backup window: the run in progress');
});

test('★★★ nextChargeableOpenMs with mid-day buys: the earlier of the next overnight and the next unvetoed super off-peak run', () => {
  const next = (y: number, mo: number, d: number, h: number) => iso(nextChargeableOpenMs(MODEL, phx(y, mo, d, h), MIDDAY));
  assert.equal(next(2026, 11, 3, 15), '2026-11-03T23:00', 'a mid-day window\'s close: the evening overnight (the post span ends at 23:00)');
  assert.equal(next(2026, 11, 3, 6), '2026-11-03T10:00');
  assert.equal(next(2026, 11, 3, 11), '2026-11-03T10:00', 'the run in progress');
  assert.equal(next(2026, 11, 6, 16), '2026-11-06T23:00', 'Friday evening');
  assert.equal(next(2026, 11, 7, 6), '2026-11-09T00:00', 'Saturday: Monday 00:00');
  // The grace: Friday 10-02's run is not chargeable; the overnight is.
  assert.equal(next(2026, 10, 2, 6), '2026-10-02T23:00');
  assert.equal(next(2026, 10, 8, 6), '2026-10-08T10:00');
  // Summer: the overnight only.
  assert.equal(next(2027, 6, 2, 6), '2027-06-02T23:00');
  // Under the overnight cycle the mid-day run never counts.
  assert.equal(iso(nextChargeableOpenMs(MODEL, phx(2026, 11, 3, 6))), '2026-11-03T23:00');
});

test('★★ nextChargeableOpenMs steps over vetoed runs to the first chargeable one', () => {
  // A model with no overnight period isolates the super off-peak scan.
  const noOvernight: TariffModel = { ...MODEL, periods: MODEL.periods.filter((p) => p.id !== APS_PERIOD.OVERNIGHT) };
  assert.equal(iso(nextChargeableOpenMs(noOvernight, phx(2026, 10, 5, 6), MIDDAY)), '2026-10-08T10:00',
    'Mon 10-05, Tue, Wed are in the grace; Thursday is the first chargeable run');
  assert.equal(nextChargeableOpenMs(noOvernight, phx(2026, 10, 5, 6), MIDDAY, 24), null, 'beyond the scan');
  assert.equal(nextChargeableOpenMs(noOvernight, phx(2026, 10, 5, 6)), null, 'the overnight cycle never counts a mid-day run');
});

test('★★★ planDateOwningCycle: a cycle belongs to the evening that plans it', () => {
  const owner = (nowMs: number, firstLegStartMs: number | null) =>
    planDateOwningCycle({ nowMs, firstLegStartMs, timezone: 'America/Phoenix', notifyMinuteOfDay: 21 * 60 + 30 });
  // Tuesday's cycle (backup Tue 23:00, cost Wed 10:00), planned Tue 16:00 and 21:30.
  assert.equal(owner(phx(2026, 11, 3, 16), phx(2026, 11, 3, 23)), '2026-11-03');
  assert.equal(owner(phx(2026, 11, 3, 21, 30), phx(2026, 11, 3, 23)), '2026-11-03');
  // Inside the backup window (after midnight) and between the legs, it is still Tuesday's.
  assert.equal(owner(phx(2026, 11, 4, 1), phx(2026, 11, 3, 23)), '2026-11-03');
  assert.equal(owner(phx(2026, 11, 4, 6), phx(2026, 11, 4, 10)), '2026-11-03', 'the cost leg recomputed at 06:00');
  assert.equal(owner(phx(2026, 11, 4, 9, 55), phx(2026, 11, 4, 10)), '2026-11-03');
  // After the cost leg, the next cycle (Wed 23:00) is Wednesday's.
  assert.equal(owner(phx(2026, 11, 4, 16), phx(2026, 11, 4, 23)), '2026-11-04');
  // The overnight cycle, as today: the plan's own date.
  assert.equal(owner(phx(2026, 11, 7, 21, 30), phx(2026, 11, 9, 0)), '2026-11-07', 'Saturday plans Monday 00:00');
  assert.equal(owner(phx(2026, 11, 8, 13), phx(2026, 11, 9, 0)), '2026-11-08');
  assert.equal(owner(phx(2026, 11, 3, 13), phx(2026, 11, 3, 23)), '2026-11-03');
  assert.equal(owner(phx(2026, 11, 3, 13), null), '2026-11-03', 'no leg: today');
  // Across a month and a year boundary.
  assert.equal(owner(phx(2027, 1, 1, 6), phx(2027, 1, 1, 10)), '2026-12-31');
});

test('★★★ per leg: the backup is resilience-only and never force-charges; the cost leg keeps the configuration', () => {
  assert.equal(legObjective('backup', 'cost'), 'resilience');
  assert.equal(legObjective('backup', 'resilience'), 'resilience');
  assert.equal(legObjective('backup', undefined), 'resilience');
  assert.equal(legObjective('cost', 'cost'), 'cost');
  assert.equal(legObjective('cost', 'resilience'), 'resilience');
  assert.equal(legObjective('cost', undefined), undefined, 'the cost leg passes the configuration through as given');
  assert.equal(legForceChargeEligible('backup', true), false);
  assert.equal(legForceChargeEligible('backup', false), false);
  assert.equal(legForceChargeEligible('cost', true), true);
  assert.equal(legForceChargeEligible('cost', false), false);
});
