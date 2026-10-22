import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApsREvModel, tariffModelFromEnv, resolveTariffFromEnv, rateAt, cheapPeriodIdOf, onPeakWindowStrings,
  parsePeriods, parseRates, parseDays, parseMonths, parseHolidays, parseHourWindow, periodLabel, TariffSpecError,
  APS_OFF_PEAK_HOLIDAYS, APS_PERIOD, type TariffModel,
} from '../src/tariff.js';

/**
 * v1.191.0 (S5b) — the period grammar (plan 2.5).
 *
 * The acceptance test: the APS R-EV preset written in the grammar parses to a model deep-equal to
 * buildApsREvModel() apart from the labels (and the plan id and the cheap-period field the custom plan
 * names explicitly). That shows the grammar can state the default exactly; a year of hourly rateAt on
 * both models agrees. The APS preset keeps its literal labels; a custom plan's labels come from its hours.
 */

const APS_IN_GRAMMAR = {
  TARIFF_PLAN: 'custom',
  TARIFF_PERIODS: 'on_peak 16-19 mon-fri all onpeak; super_off_peak 10-15 mon-fri winter; overnight 23-05 mon-fri all cheap',
  TARIFF_RATES: 'on_peak=31.17/22.47; off_peak=16.91/15.07; overnight=12.59; super_off_peak=-/8.2',
  TARIFF_SUMMER_MONTHS: '4-9',
  TARIFF_HOLIDAYS: 'aps',
  TARIFF_RATES_CONFIRMED: 'true',
};
const APS_RATES = {
  onPeak: { summer: 31.17, winter: 22.47 }, offPeak: { summer: 16.91, winter: 15.07 },
  overnight: { summer: 12.59, winter: 12.59 }, superOffPeak: { summer: null, winter: 8.2 }, confirmed: true,
};
const KEYS = ['TARIFF_PLAN', 'TARIFF_PERIODS', 'TARIFF_RATES', 'TARIFF_SUMMER_MONTHS', 'TARIFF_HOLIDAYS', 'TARIFF_RATES_CONFIRMED',
  'TARIFF_FIXED_DAILY_CENTS', 'NIGHT_CHARGE_CHEAP_PERIOD', 'TARIFF_APS_RATES_CONFIRMED'];

function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const phx = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h + 7);
/** The model without its labels, plan id and explicit cheap period — what the grammar must reproduce. */
function structural(m: TariffModel): unknown {
  const { planId: _p, cheapPeriodId: _c, ...rest } = m;
  return { ...rest, periods: rest.periods.map(({ label: _l, ...p }) => p), offPeak: { ...rest.offPeak, label: '' } };
}

test('★★★ the APS preset written in the grammar parses deep-equal to buildApsREvModel(), apart from the labels', () => {
  withEnv(APS_IN_GRAMMAR, () => {
    const r = resolveTariffFromEnv();
    assert.equal(r.error, null);
    const parsed = tariffModelFromEnv();
    const preset = buildApsREvModel(APS_RATES);
    assert.deepStrictEqual(structural(parsed), structural(preset));
    assert.equal(cheapPeriodIdOf(parsed), cheapPeriodIdOf(preset), 'the cheap period is overnight on both');
    assert.deepEqual(onPeakWindowStrings(parsed), onPeakWindowStrings(preset));
    assert.deepEqual(parsed.holidays, [...APS_OFF_PEAK_HOLIDAYS]);
  });
});

test('★★★ a year of hourly rates agrees between the preset and its grammar form (holidays, seasons, wrap at midnight)', () => {
  withEnv(APS_IN_GRAMMAR, () => {
    const parsed = tariffModelFromEnv();
    const preset = buildApsREvModel(APS_RATES);
    for (let t = phx(2026, 1, 1); t < phx(2027, 1, 1); t += 3_600_000) {
      const a = rateAt(parsed, t);
      const b = rateAt(preset, t);
      assert.deepEqual([a.periodId, a.season, a.centsPerKwh, a.isOnPeak], [b.periodId, b.season, b.centsPerKwh, b.isOnPeak], new Date(t).toISOString());
    }
  });
});

test('★★ the APS preset keeps its literal labels; a custom plan\'s labels come from its hours', () => {
  const preset = buildApsREvModel();
  assert.deepEqual(preset.periods.map((p) => p.label), ['On-Peak (4–7pm Mon–Fri)', 'Super Off-Peak (10am–3pm Mon–Fri, winter)', 'Overnight (11pm–5am Mon–Fri)']);
  assert.equal(preset.offPeak.label, 'Off-Peak (nights/weekends/holidays)');
  withEnv(APS_IN_GRAMMAR, () => {
    const parsed = tariffModelFromEnv();
    assert.deepEqual(parsed.periods.map((p) => p.label), ['On peak (16:00–19:00 Mon–Fri)', 'Super off peak (10:00–15:00 Mon–Fri, winter)', 'Overnight (23:00–05:00 Mon–Fri)']);
    assert.equal(parsed.offPeak.label, 'Off-peak (all other hours)');
  });
  assert.equal(periodLabel({ id: 'weekend_day', startHour: 8, endHour: 20, weekdays: [0, 6], seasons: ['summer'] }), 'Weekend day (08:00–20:00 Sat–Sun, summer)');
  assert.equal(periodLabel({ id: 'x', startHour: 0, endHour: 24, weekdays: null, seasons: null }), 'X (00:00–24:00 every day)');
  assert.equal(periodLabel({ id: 'mwf', startHour: 6, endHour: 9, weekdays: [1, 3, 5], seasons: null }), 'Mwf (06:00–09:00 Mon, Wed, Fri)');
});

/* ── the pieces ───────────────────────────────────────────────────────────────────────────── */

test('★★★ months: a range may wrap the year (10-3), lists combine, none is no summer', () => {
  assert.deepEqual(parseMonths('4-9'), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseMonths('10-3'), [1, 2, 3, 10, 11, 12]);
  assert.deepEqual(parseMonths('11-2, 6'), [1, 2, 6, 11, 12]);
  assert.deepEqual(parseMonths('12-12'), [12]);
  assert.deepEqual(parseMonths('none'), []);
  for (const bad of ['0-3', '4-13', 'apr-sep', '4-9-10', '']) assert.throws(() => parseMonths(bad), TariffSpecError, bad);
});

test('days: names, ranges (wrapping), lists, all', () => {
  assert.deepEqual(parseDays('mon-fri', 'x'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('fri-mon', 'x'), [0, 1, 5, 6]);
  assert.deepEqual(parseDays('sat,sun', 'x'), [0, 6]);
  assert.deepEqual(parseDays('mon,wed-thu', 'x'), [1, 3, 4]);
  assert.equal(parseDays('all', 'x'), null);
  assert.equal(parseDays('mon-sun', 'x'), null, 'every day is null, as in the model');
  for (const bad of ['monday', 'mon-', '1-5', 'mon-fri-sat']) assert.throws(() => parseDays(bad, 'x'), TariffSpecError, bad);
});

test('hours: HH-HH local, end-exclusive; a start above the end wraps midnight; an empty window is refused', () => {
  assert.deepEqual(parseHourWindow('16-19', 'x'), { startHour: 16, endHour: 19 });
  assert.deepEqual(parseHourWindow('23-05', 'x'), { startHour: 23, endHour: 5 });
  assert.deepEqual(parseHourWindow('0-24', 'x'), { startHour: 0, endHour: 24 });
  for (const bad of ['16', '16-25', '24-5', '7-7', '0-0', '4pm-7pm']) assert.throws(() => parseHourWindow(bad, 'x'), TariffSpecError, bad);
});

test('rates: per season, both seasons, `-` for none; any finite number; a period given twice is refused', () => {
  assert.deepEqual([...parseRates('on_peak=31.17/22.47; overnight=12.59; super_off_peak=-/8.2; free=0; credit=-1.5')], [
    ['on_peak', { summer: 31.17, winter: 22.47 }], ['overnight', { summer: 12.59, winter: 12.59 }],
    ['super_off_peak', { summer: null, winter: 8.2 }], ['free', { summer: 0, winter: 0 }], ['credit', { summer: -1.5, winter: -1.5 }],
  ]);
  for (const bad of ['a=1; a=2', 'a=x', 'a=1/2/3', 'A=1', 'a 1']) assert.throws(() => parseRates(bad), TariffSpecError, bad);
});

test('holidays: aps, none or real dates', () => {
  assert.deepEqual(parseHolidays('aps'), [...APS_OFF_PEAK_HOLIDAYS]);
  assert.deepEqual(parseHolidays('none'), []);
  assert.deepEqual(parseHolidays('2027-12-25,2027-01-01'), ['2027-01-01', '2027-12-25']);
  for (const bad of ['2027-02-29', '2027-13-01', 'xmas', '27-12-25']) assert.throws(() => parseHolidays(bad), TariffSpecError, bad);
});

test('periods: priority order, one onpeak, one cheap, every period and off_peak priced, nothing priced that is not a period', () => {
  const p = parsePeriods('a 6-9 all all; b 0-24 sat-sun summer onpeak', 'a=1; b=2/-; off_peak=3');
  assert.deepEqual(p.periods.map((x) => [x.id, x.startHour, x.endHour, x.weekdays, x.seasons, x.onPeak ?? false]), [
    ['a', 6, 9, null, null, false], ['b', 0, 24, [0, 6], ['summer'], true],
  ]);
  assert.equal(p.cheapPeriodId, null);
  assert.deepEqual(p.offPeak, { summer: 3, winter: 3 });
  const bad: Array<[string, string, RegExp]> = [
    ['a 6-9 all all; a 10-11 all all', 'a=1; off_peak=2', /listed twice/],
    ['off_peak 6-9 all all', 'off_peak=2', /implicit base period/],
    ['a 6-9 all all onpeak; b 10-11 all all onpeak', 'a=1; b=1; off_peak=2', /more than one period is flagged onpeak/],
    ['a 6-9 all all cheap; b 10-11 all all cheap', 'a=1; b=1; off_peak=2', /more than one period is flagged cheap/],
    ['a 6-9 all all fast', 'a=1; off_peak=2', /"fast" is not a flag/],
    ['a 6-9 all spring', 'a=1; off_peak=2', /season "spring"/],
    ['a 6-9 all all', 'off_peak=2', /no rate for a/],
    ['a 6-9 all all', 'a=1', /no rate for off_peak/],
    ['a 6-9 all all', 'a=1; b=2; off_peak=3', /b is not a period in TARIFF_PERIODS/],
    ['', 'off_peak=3', /no period is listed/],
    ['Peak 6-9 all all', 'off_peak=3', /not a period id/],
  ];
  for (const [periods, rates, why] of bad) assert.throws(() => parsePeriods(periods, rates), why, `${periods} | ${rates}`);
});

test('the parsed custom plan is not the APS preset: its id is custom and it reads only its own table', () => {
  withEnv({ ...APS_IN_GRAMMAR, TARIFF_APS_RATES_CONFIRMED: 'false' }, () => {
    const m = tariffModelFromEnv();
    assert.equal(m.planId, 'custom');
    assert.equal(m.ratesConfirmed, true, 'TARIFF_RATES_CONFIRMED decides for the custom plan');
    assert.equal(rateAt(m, phx(2026, 7, 15, 17)).periodId, APS_PERIOD.ON_PEAK);
  });
});
