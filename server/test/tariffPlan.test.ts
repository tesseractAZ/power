import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildApsREvModel, apsREvRatesFromEnv, apsREvModelFromEnv, tariffModelFromEnv, resolveTariffFromEnv, rateAt, seasonAt,
  cheapPeriodIdOf, legacyTariffFromEnv, legacyOnPeakWindow, tariffRatesConfirmation, tariffRepairIssues,
  referenceHomeTariffDefaults, referenceHomeTariffNotice, apsOffPeakHolidays, localParts, isModelHoliday,
  APS_OFF_PEAK_HOLIDAYS, APS_PERIOD, TARIFF_SPEC_ISSUE_ID, TARIFF_CURRENCY_ISSUE_ID, REFERENCE_HOME_DEFAULTS_ISSUE_ID,
  TARIFF_FLAT_DEFAULT_CENTS, positiveCents, type TariffModel,
} from '../src/tariff.js';
import { resolveCheapWindow } from '../src/chargeWindows.js';
import { fmtMoney, fmtMinor, tariffCurrency, CURRENCIES } from '../src/money.js';
import { SENSORS, BINARY_SENSORS, sensorDiscoveryConfig, sensorsInCurrency, auditDiscoveryTables } from '../src/mqttDiscovery.js';
import { peakGridDrawAlerts, type PeakDrawVerdict } from '../src/peakGridDraw.js';
import { realizedCostOutcome } from '../src/nightLedgerScoring.js';
import { recommendDispatch, type MpcInputs } from '../src/dispatch/mpc.js';
import { resolveTariffCents, hourlyRateCents, isOnPeakHour, mpcFallbackPair, DISPATCH_ROUND_TRIP_EFFICIENCY as AN_DISPATCH_RTE } from '../src/analytics.js';
import { DISPATCH_ROUND_TRIP_EFFICIENCY, MPC_ROUND_TRIP_EFFICIENCY } from '../src/limits.js';
import { siteResponse } from '../src/site.js';
import { OPTIONS } from '../src/config.js';
import { siteTimeZone, zonedWallTimeMs } from '../src/siteTime.js';

/**
 * v1.191.0 (S5) — the tariff plan, read from the options (plan 2.5, 3.2, 3.3, 3.5; CA14, CA20).
 *
 * The owner's install leaves every new key unset: there the model is today's APS R-EV model, the legacy
 * ladder reads what it read, the units are USD and the text is today's (goldens G2 and G7 pin the same
 * from the other side). The rest pins the new plans: flat, two_tier, seasons that wrap the year, holiday
 * lists, a 0 ¢ period, EUR units — and P5: an unusable spec nulls the money and holds the night charge,
 * and never becomes the APS table.
 */

const TARIFF_KEYS = [
  'TARIFF_PLAN', 'TARIFF_PERIODS', 'TARIFF_RATES', 'TARIFF_RATES_CONFIRMED', 'TARIFF_FIXED_DAILY_CENTS', 'TARIFF_SUMMER_MONTHS',
  'TARIFF_HOLIDAYS', 'TARIFF_CURRENCY', 'NIGHT_CHARGE_CHEAP_PERIOD', 'TARIFF_FLAT_CENTS_PER_KWH', 'TARIFF_ON_PEAK_CENTS',
  'TARIFF_OFF_PEAK_CENTS', 'TARIFF_ON_PEAK_CENTS_PER_KWH', 'TARIFF_OFF_PEAK_CENTS_PER_KWH', 'TARIFF_EXPORT_CENTS_PER_KWH',
  'TARIFF_ON_PEAK_HOURS', 'TARIFF_ON_PEAK_DAYS',
  'TARIFF_APS_ONPEAK_SUMMER_CENTS', 'TARIFF_APS_ONPEAK_WINTER_CENTS', 'TARIFF_APS_OFFPEAK_SUMMER_CENTS', 'TARIFF_APS_OFFPEAK_WINTER_CENTS',
  'TARIFF_APS_OVERNIGHT_CENTS', 'TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS', 'TARIFF_APS_RATES_CONFIRMED',
] as const;
/** The owner's shipped defaults: every APS cent blank, unconfirmed; every new key absent. */
const SHIPPED: Record<string, string | undefined> = {
  TARIFF_APS_ONPEAK_SUMMER_CENTS: '', TARIFF_APS_ONPEAK_WINTER_CENTS: '', TARIFF_APS_OFFPEAK_SUMMER_CENTS: '',
  TARIFF_APS_OFFPEAK_WINTER_CENTS: '', TARIFF_APS_OVERNIGHT_CENTS: '', TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '',
  TARIFF_APS_RATES_CONFIRMED: 'false',
};
/** Confirmed synthetic APS rates (the shape S0 C3 recorded on the reference install: six finite cents > 0). */
const CONFIRMED_APS: Record<string, string> = {
  TARIFF_APS_ONPEAK_SUMMER_CENTS: '31.17', TARIFF_APS_ONPEAK_WINTER_CENTS: '22.47', TARIFF_APS_OFFPEAK_SUMMER_CENTS: '16.91',
  TARIFF_APS_OFFPEAK_WINTER_CENTS: '15.07', TARIFF_APS_OVERNIGHT_CENTS: '12.59', TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '8.2',
  TARIFF_APS_RATES_CONFIRMED: 'true',
};

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  const all: Record<string, string | undefined> = { ...Object.fromEntries(TARIFF_KEYS.map((k) => [k, undefined])), ...SHIPPED, ...patch };
  for (const [k, v] of Object.entries(all)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A local Phoenix wall-clock time (fixed UTC−7) as epoch ms. */
const phx = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h + 7, min);
const HOUR = 3_600_000;

/* ── the owner's install: TARIFF_PLAN unset is today's model ─────────────────────────────── */

test('★★★ TARIFF_PLAN unset: the model is deep-equal to today\'s APS R-EV model (shipped and confirmed rates)', () => {
  for (const env of [{}, CONFIRMED_APS]) {
    withEnv(env, () => {
      const model = tariffModelFromEnv();
      assert.deepStrictEqual(model, buildApsREvModel(apsREvRatesFromEnv()));
      assert.equal(model.planId, 'aps_r_ev');
      assert.equal('cheapPeriodId' in model, false, 'the APS model JSON gains no field (golden G2)');
      assert.equal(cheapPeriodIdOf(model), APS_PERIOD.OVERNIGHT);
      assert.deepStrictEqual(apsREvModelFromEnv(), model, 'the deprecated alias reads the same model');
      const r = resolveTariffFromEnv();
      assert.equal(r.error, null);
      assert.equal(r.planSet, false);
      assert.equal(r.confirmationKey, 'TARIFF_APS_RATES_CONFIRMED');
      assert.deepEqual(tariffRepairIssues(), []);
    });
  }
});

test('★★ the TARIFF_APS_* keys stay the inputs of the aps_r_ev preset (unset and explicit)', () => {
  for (const plan of [undefined, 'aps_r_ev']) {
    withEnv({ ...CONFIRMED_APS, TARIFF_PLAN: plan }, () => {
      const m = tariffModelFromEnv();
      assert.equal(m.ratesConfirmed, true);
      assert.equal(rateAt(m, phx(2026, 7, 15, 17)).centsPerKwh, 31.17); // summer on-peak
      assert.equal(rateAt(m, phx(2026, 1, 14, 12)).centsPerKwh, 8.2); // winter super-off-peak
      assert.equal(rateAt(m, phx(2026, 7, 15, 1)).centsPerKwh, 12.59); // overnight
      assert.equal(rateAt(m, phx(2026, 7, 18, 12)).centsPerKwh, 16.91); // Saturday off-peak
    });
  }
});

test('★★ TARIFF_RATES_CONFIRMED overrides TARIFF_APS_RATES_CONFIRMED; unset takes it', () => {
  withEnv({ ...CONFIRMED_APS, TARIFF_RATES_CONFIRMED: 'false' }, () => {
    assert.deepEqual(tariffRatesConfirmation(), { confirmed: false, key: 'TARIFF_RATES_CONFIRMED' });
    assert.equal(tariffModelFromEnv().ratesConfirmed, false);
    assert.equal(rateAt(tariffModelFromEnv(), phx(2026, 7, 15, 17)).centsPerKwh, null);
  });
  withEnv({ ...CONFIRMED_APS, TARIFF_APS_RATES_CONFIRMED: 'false', TARIFF_RATES_CONFIRMED: 'true' }, () => {
    assert.deepEqual(tariffRatesConfirmation(), { confirmed: true, key: 'TARIFF_RATES_CONFIRMED' });
    assert.equal(tariffModelFromEnv().ratesConfirmed, true);
  });
  withEnv(CONFIRMED_APS, () => assert.deepEqual(tariffRatesConfirmation(), { confirmed: true, key: 'TARIFF_APS_RATES_CONFIRMED' }));
});

test('★★ the legacy ladder reads exactly what its readers read; the two-tier names are not cross-aliased while TARIFF_PLAN is unset', () => {
  withEnv({}, () => {
    assert.deepEqual(legacyTariffFromEnv(), {
      flatCents: 17, kpi: { onPeak: null, offPeak: null }, mpc: { onPeak: 17, offPeak: 17 }, exportCents: 0, onPeakHours: '15-20', onPeakDays: '1-5',
    });
    assert.equal(TARIFF_FLAT_DEFAULT_CENTS, 17);
    assert.deepEqual(legacyOnPeakWindow(tariffModelFromEnv()), { hours: '15-20', days: '1-5' });
  });
  withEnv({ TARIFF_FLAT_CENTS_PER_KWH: '21' }, () => assert.deepEqual(legacyTariffFromEnv().mpc, { onPeak: 21, offPeak: 21 }));
  // golden G2 twoTierAnalyticsNames / twoTierMpcNames: each path ignores the other's names (declared, not unified).
  withEnv({ TARIFF_ON_PEAK_CENTS: '30', TARIFF_OFF_PEAK_CENTS: '10' }, () => {
    const l = legacyTariffFromEnv();
    assert.deepEqual(l.kpi, { onPeak: 30, offPeak: 10 });
    assert.deepEqual(l.mpc, { onPeak: 17, offPeak: 17 });
    assert.equal(resolveTariffCents(phx(2026, 7, 1, 12)).basis, 'explicit-override');
    // v1.191.0 (review 3) — the MPC vector's pair (index.ts reads it through mpcFallbackPair) is still its own.
    assert.deepEqual(mpcFallbackPair(phx(2026, 7, 1, 12)), { onPeak: 17, offPeak: 17 });
  });
  withEnv({ TARIFF_ON_PEAK_CENTS_PER_KWH: '30', TARIFF_OFF_PEAK_CENTS_PER_KWH: '10' }, () => {
    const l = legacyTariffFromEnv();
    assert.deepEqual(l.kpi, { onPeak: null, offPeak: null });
    assert.deepEqual(l.mpc, { onPeak: 30, offPeak: 10 });
    assert.equal(resolveTariffCents(phx(2026, 7, 1, 12)).basis, 'flat-default');
    assert.deepEqual(mpcFallbackPair(phx(2026, 7, 1, 12)), { onPeak: 30, offPeak: 10 });
  });
  withEnv({ TARIFF_FLAT_CENTS_PER_KWH: '21' }, () => assert.deepEqual(mpcFallbackPair(phx(2026, 7, 1, 12)), { onPeak: 21, offPeak: 21 }));
  // The KPI path keeps its above-zero rule (DECISION 8): a 0 ¢ override is no override.
  withEnv({ TARIFF_ON_PEAK_CENTS: '0', TARIFF_OFF_PEAK_CENTS: '10' }, () => assert.equal(legacyTariffFromEnv().kpi.onPeak, null));
  assert.equal(positiveCents(0), null);
  assert.equal(positiveCents(-1), null);
  assert.equal(positiveCents(8.2), 8.2);
});

test('the cost figures\' pair on the APS preset: the model\'s season and cents, basis aps_r_ev-<season> (R6)', () => {
  withEnv(CONFIRMED_APS, () => {
    assert.deepEqual(resolveTariffCents(phx(2026, 7, 1, 12)), { onPeak: 31.17, offPeak: 16.91, basis: 'aps_r_ev-summer' });
    assert.deepEqual(resolveTariffCents(phx(2026, 10, 15, 12)), { onPeak: 22.47, offPeak: 15.07, basis: 'aps_r_ev-winter' });
  });
});

test('★★ DECISION 8 kept on the cost-figure path: a confirmed 0 ¢ APS rate prices 0 in the model, and the pair falls to the flat ladder', () => {
  withEnv({ ...CONFIRMED_APS, TARIFF_APS_OFFPEAK_SUMMER_CENTS: '0' }, () => {
    assert.equal(rateAt(tariffModelFromEnv(), phx(2026, 7, 18, 12)).centsPerKwh, 0, 'the model path: any finite value');
    assert.deepEqual(resolveTariffCents(phx(2026, 7, 1, 12)), { onPeak: 17, offPeak: 17, basis: 'flat-default' }, 'the KPI path: above zero only');
  });
  for (const [key, at] of [['TARIFF_APS_ONPEAK_WINTER_CENTS', phx(2026, 1, 14, 12)], ['TARIFF_APS_OFFPEAK_WINTER_CENTS', phx(2026, 1, 14, 12)]] as const) {
    for (const v of ['0', '-2']) {
      withEnv({ ...CONFIRMED_APS, [key]: v }, () => {
        assert.deepEqual(resolveTariffCents(at), { onPeak: 17, offPeak: 17, basis: 'flat-default' }, `${key}=${v}: the KPI pair needs both rates above zero`);
      });
    }
  }
});

test('the two round-trip efficiencies are named in limits.ts with today\'s values (DECISION 9)', () => {
  assert.equal(DISPATCH_ROUND_TRIP_EFFICIENCY, 0.86);
  assert.equal(MPC_ROUND_TRIP_EFFICIENCY, 0.9);
  assert.equal(AN_DISPATCH_RTE, DISPATCH_ROUND_TRIP_EFFICIENCY, 'analytics.ts re-exports the limits.ts constant');
});

/* ── CA20: reference-home defaults (the tariff half; lane C raises the one issue) ───────────── */

test('★★ CA20: the reference-home tariff notice is silent in America/Phoenix and when TARIFF_PLAN is set', () => {
  withEnv({}, () => {
    assert.equal(referenceHomeTariffDefaults('America/Phoenix'), false);
    assert.equal(referenceHomeTariffNotice('America/Phoenix'), null);
    assert.equal(referenceHomeTariffDefaults('Europe/Berlin'), true);
    assert.match(referenceHomeTariffNotice('Europe/Berlin')!, /Europe\/Berlin.*TARIFF_PLAN is unset/);
  });
  withEnv({ TARIFF_PLAN: 'aps_r_ev' }, () => assert.equal(referenceHomeTariffDefaults('Europe/Berlin'), false, 'an explicit aps_r_ev keeps the preset knowingly'));
  assert.equal(REFERENCE_HOME_DEFAULTS_ISSUE_ID, 'reference-home-defaults');
});

/* ── flat and two_tier ─────────────────────────────────────────────────────────────────────── */

test('★★ a flat plan prices every hour at TARIFF_FLAT_CENTS_PER_KWH and has no cheap window', () => {
  withEnv({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '14.5', TARIFF_RATES_CONFIRMED: 'true' }, () => {
    const m = tariffModelFromEnv();
    assert.equal(m.planId, 'flat');
    assert.equal(m.ratesConfirmed, true);
    assert.equal(cheapPeriodIdOf(m), null);
    for (let t = phx(2026, 3, 2); t < phx(2026, 3, 9); t += HOUR) {
      const r = rateAt(m, t);
      assert.equal(r.centsPerKwh, 14.5);
      assert.equal(r.isOnPeak, false);
    }
    assert.deepEqual(resolveTariffCents(phx(2026, 7, 1, 12)), { onPeak: 14.5, offPeak: 14.5, basis: 'flat-summer' });
    assert.equal(hourlyRateCents(phx(2026, 7, 1, 17), { onPeak: 99, offPeak: 99 }), 14.5);
    assert.equal(resolveCheapWindow((t) => rateAt(m, t).periodId, phx(2026, 3, 2, 21, 30), cheapPeriodIdOf(m) ?? '', 30), null);
  });
  withEnv({ TARIFF_PLAN: 'flat', TARIFF_RATES_CONFIRMED: 'true' }, () => {
    const r = resolveTariffFromEnv();
    assert.match(r.error!, /TARIFF_PLAN flat needs TARIFF_FLAT_CENTS_PER_KWH/);
    assert.equal(r.model.planId, 'invalid');
  });
});

test('★★ a two_tier plan: one on-peak window from TARIFF_ON_PEAK_HOURS / _DAYS; the MPC names are accepted as aliases', () => {
  withEnv({ TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '17-21', TARIFF_ON_PEAK_DAYS: '1-5', TARIFF_ON_PEAK_CENTS_PER_KWH: '30', TARIFF_OFF_PEAK_CENTS_PER_KWH: '10', TARIFF_RATES_CONFIRMED: 'true' }, () => {
    const m = tariffModelFromEnv();
    assert.equal(m.planId, 'two_tier');
    assert.equal(m.periods.length, 1);
    assert.equal(m.periods[0].label, 'On peak (17:00–21:00 Mon–Fri)');
    assert.deepEqual(m.periods[0].weekdays, [1, 2, 3, 4, 5]);
    assert.equal(rateAt(m, phx(2026, 3, 4, 18)).centsPerKwh, 30); // Wednesday 18:00
    assert.equal(rateAt(m, phx(2026, 3, 4, 18)).isOnPeak, true);
    assert.equal(rateAt(m, phx(2026, 3, 4, 21)).centsPerKwh, 10); // end-exclusive
    assert.equal(rateAt(m, phx(2026, 3, 7, 18)).centsPerKwh, 10); // Saturday
    assert.equal(isOnPeakHour(phx(2026, 3, 4, 18)), true);
    assert.equal(cheapPeriodIdOf(m), null);
    assert.deepEqual(legacyOnPeakWindow(m), { hours: '17-21', days: '1-5' });
  });
  // The bridged names win over the MPC aliases; any finite value counts on the model path.
  withEnv({ TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_CENTS: '25', TARIFF_ON_PEAK_CENTS_PER_KWH: '30', TARIFF_OFF_PEAK_CENTS: '0', TARIFF_RATES_CONFIRMED: 'true' }, () => {
    const m = tariffModelFromEnv();
    assert.equal(m.periods[0].startHour, 15, 'TARIFF_ON_PEAK_HOURS unset is the legacy 15-20');
    assert.equal(rateAt(m, phx(2026, 3, 4, 16)).centsPerKwh, 25);
    assert.equal(rateAt(m, phx(2026, 3, 4, 12)).centsPerKwh, 0);
  });
  withEnv({ TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_CENTS: '25' }, () => assert.match(resolveTariffFromEnv().error!, /needs TARIFF_OFF_PEAK_CENTS/));
});

test('★★★ an unconfirmed two_tier plan: the MPC vector and the cost figures price an hour with the plan\'s own two rates (review 3)', () => {
  // The guide's two-period home, rates entered, not yet confirmed. The cost figures read the plan's
  // pair (explicit-override); the MPC read the environment-only …_CENTS_PER_KWH pair, which no option
  // sets, so it priced every hour, and valued every shifted kWh, at the 17 ¢ flat default.
  const TWO_TIER = { TARIFF_PLAN: 'two_tier', TARIFF_ON_PEAK_HOURS: '14-19', TARIFF_ON_PEAK_DAYS: '1-5', TARIFF_ON_PEAK_CENTS: '32', TARIFF_OFF_PEAK_CENTS: '11' };
  // Wednesday 16:00 on the site clock lies in the on-peak window (in the test process's legacy window too,
  // 15-20, which analytics.ts read at load); 03:00 does not. Site-clock instants: the fallback judges the
  // site's hour, so the case holds whatever zone the test process runs in.
  const onPeakHour = zonedWallTimeMs('2026-10-21', 16, 0, siteTimeZone());
  const offPeakHour = zonedWallTimeMs('2026-10-21', 3, 0, siteTimeZone());
  withEnv(TWO_TIER, () => {
    assert.equal(tariffModelFromEnv().ratesConfirmed, false);
    assert.equal(rateAt(tariffModelFromEnv(), onPeakHour).centsPerKwh, null, 'unconfirmed: the table prices nothing');
    const cost = resolveTariffCents(onPeakHour);
    assert.deepEqual(cost, { onPeak: 32, offPeak: 11, basis: 'explicit-override' });
    const mpc = mpcFallbackPair(onPeakHour);
    assert.deepEqual(mpc, { onPeak: 32, offPeak: 11 }, 'the MPC falls back to the cost figures\' pair, not to 17/17');
    assert.equal(hourlyRateCents(onPeakHour, mpc), 32);
    assert.equal(hourlyRateCents(offPeakHour, mpc), 11);
    assert.equal(hourlyRateCents(onPeakHour, mpc), hourlyRateCents(onPeakHour, cost));
    assert.equal(hourlyRateCents(offPeakHour, mpc), hourlyRateCents(offPeakHour, cost));
    // The legacy ladder itself is unchanged: the MPC names still read the flat rate when absent.
    assert.deepEqual(legacyTariffFromEnv().mpc, { onPeak: 17, offPeak: 17 });
  });
  // Confirmed, the table prices both paths and the pair is the same.
  withEnv({ ...TWO_TIER, TARIFF_RATES_CONFIRMED: 'true' }, () => {
    const mpc = mpcFallbackPair(onPeakHour);
    assert.deepEqual(mpc, { onPeak: 32, offPeak: 11 });
    assert.equal(hourlyRateCents(onPeakHour, mpc), 32);
    assert.equal(hourlyRateCents(offPeakHour, mpc), 11);
  });
  // Any plan set: the MPC's pair is the cost figures' pair (a custom plan with no override: the flat rate).
  withEnv({ TARIFF_PLAN: 'custom', TARIFF_PERIODS: 'on_peak 16-19 mon-fri all onpeak', TARIFF_RATES: 'on_peak=30; off_peak=12' }, () => {
    const { onPeak, offPeak } = resolveTariffCents(onPeakHour);
    assert.deepEqual(mpcFallbackPair(onPeakHour), { onPeak, offPeak });
    assert.equal(resolveTariffCents(onPeakHour).basis, 'flat-default');
  });
  // The reference install (TARIFF_PLAN unset): the MPC keeps its own names (golden G2), whatever the cost figures read.
  withEnv({ TARIFF_ON_PEAK_CENTS: '32', TARIFF_OFF_PEAK_CENTS: '11' }, () => {
    assert.equal(resolveTariffFromEnv().planSet, false);
    assert.deepEqual(mpcFallbackPair(onPeakHour), { onPeak: 17, offPeak: 17 });
  });
});

/* ── seasons, holidays, fixed charge, cheap period ─────────────────────────────────────────── */

test('★★★ TARIFF_SUMMER_MONTHS=10-3 wraps the year (a southern-hemisphere home)', () => {
  withEnv({ ...CONFIRMED_APS, TARIFF_SUMMER_MONTHS: '10-3' }, () => {
    const m = tariffModelFromEnv();
    assert.deepEqual(m.summerMonths, [1, 2, 3, 10, 11, 12]);
    assert.equal(seasonAt(m, phx(2026, 1, 14, 12)), 'summer');
    assert.equal(seasonAt(m, phx(2026, 7, 15, 12)), 'winter');
    // The winter-only super-off-peak period now falls in July.
    assert.equal(rateAt(m, phx(2026, 7, 15, 12)).periodId, APS_PERIOD.SUPER_OFF_PEAK);
    assert.equal(rateAt(m, phx(2026, 1, 14, 12)).periodId, APS_PERIOD.OFF_PEAK);
  });
});

test('★★ TARIFF_HOLIDAYS=none: an APS holiday is priced like any weekday', () => {
  const thanksgiving = phx(2026, 11, 26, 17); // Thursday, 17:00
  withEnv(CONFIRMED_APS, () => assert.equal(rateAt(tariffModelFromEnv(), thanksgiving).periodId, APS_PERIOD.OFF_PEAK));
  withEnv({ ...CONFIRMED_APS, TARIFF_HOLIDAYS: 'none' }, () => {
    const m = tariffModelFromEnv();
    assert.deepEqual(m.holidays, []);
    assert.equal(rateAt(m, thanksgiving).periodId, APS_PERIOD.ON_PEAK);
  });
  withEnv({ ...CONFIRMED_APS, TARIFF_HOLIDAYS: '2026-11-25, 2026-11-26' }, () => {
    const m = tariffModelFromEnv();
    assert.deepEqual(m.holidays, ['2026-11-25', '2026-11-26']);
    assert.equal(rateAt(m, phx(2026, 11, 25, 17)).periodId, APS_PERIOD.OFF_PEAK);
  });
});

test('★★★ R3: the APS holidays are identical to the 2015–2045 table and computed after 2045 (declared)', () => {
  withEnv(CONFIRMED_APS, () => {
    const m = tariffModelFromEnv();
    assert.deepEqual(m.holidays, [...APS_OFF_PEAK_HOLIDAYS], 'the model\'s list is today\'s table');
    for (const ymd of APS_OFF_PEAK_HOLIDAYS.filter((d) => d.startsWith('2045'))) {
      const [y, mo, d] = ymd.split('-').map(Number);
      assert.equal(isModelHoliday(m, localParts(phx(y, mo, d, 12), m.timezone)), true, ymd);
    }
    // A weekday holiday of 2046 (outside the table) is off-peak all day; the same weekday a week later is not.
    const weekday2046 = apsOffPeakHolidays(2046).find((ymd) => {
      const [y, mo, d] = ymd.split('-').map(Number);
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      return y === 2046 && dow >= 1 && dow <= 5 && !apsOffPeakHolidays(2046).includes(new Date(Date.UTC(y, mo - 1, d + 7)).toISOString().slice(0, 10));
    })!;
    assert.ok(weekday2046, 'a weekday holiday in 2046');
    assert.ok(!APS_OFF_PEAK_HOLIDAYS.includes(weekday2046));
    const [y, mo, d] = weekday2046.split('-').map(Number);
    assert.equal(rateAt(m, phx(y, mo, d, 17)).periodId, APS_PERIOD.OFF_PEAK, `${weekday2046} 17:00`);
    assert.equal(rateAt(m, phx(y, mo, d + 7, 17)).periodId, APS_PERIOD.ON_PEAK, 'a week later');
    // A list the operator wrote carries no rule past its own dates.
    const listed: TariffModel = { ...m, holidays: [...APS_OFF_PEAK_HOLIDAYS] };
    assert.equal(rateAt(listed, phx(y, mo, d, 17)).periodId, APS_PERIOD.ON_PEAK);
  });
});

test('TARIFF_FIXED_DAILY_CENTS is surfaced only once the rates are confirmed', () => {
  withEnv({ TARIFF_FIXED_DAILY_CENTS: '42.5' }, () => assert.equal(tariffModelFromEnv().fixedDailyCents, null));
  withEnv({ ...CONFIRMED_APS, TARIFF_FIXED_DAILY_CENTS: '42.5' }, () => assert.equal(tariffModelFromEnv().fixedDailyCents, 42.5));
  withEnv({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '12', TARIFF_RATES_CONFIRMED: 'true', TARIFF_FIXED_DAILY_CENTS: '30' }, () => assert.equal(tariffModelFromEnv().fixedDailyCents, 30));
});

test('★★ NIGHT_CHARGE_CHEAP_PERIOD overrides the cheap period (the DECISION 13 hook); the model otherwise defaults to overnight', () => {
  withEnv({ NIGHT_CHARGE_CHEAP_PERIOD: 'super_off_peak' }, () => {
    const m = tariffModelFromEnv();
    assert.equal(cheapPeriodIdOf(m), 'super_off_peak');
    const { cheapPeriodId, ...rest } = m;
    assert.equal(cheapPeriodId, 'super_off_peak');
    assert.deepStrictEqual(rest, buildApsREvModel(apsREvRatesFromEnv()), 'nothing else changes');
  });
  withEnv({ TARIFF_PLAN: 'flat', TARIFF_FLAT_CENTS_PER_KWH: '12', NIGHT_CHARGE_CHEAP_PERIOD: 'off_peak' }, () => assert.equal(cheapPeriodIdOf(tariffModelFromEnv()), 'off_peak'));
});

/* ── custom plan: a 0 ¢ period on the model path ───────────────────────────────────────────── */

const CUSTOM = {
  TARIFF_PLAN: 'custom',
  TARIFF_PERIODS: 'peak 17-21 mon-fri all onpeak; night 0-6 all all cheap',
  TARIFF_RATES: 'peak=40/30; night=0; off_peak=20',
  TARIFF_RATES_CONFIRMED: 'true',
};

test('★★★ a 0 ¢ period is priced at 0 on the model path (any finite value; DECISION 8)', () => {
  withEnv(CUSTOM, () => {
    const m = tariffModelFromEnv();
    assert.equal(m.planId, 'custom');
    assert.equal(cheapPeriodIdOf(m), 'night');
    const r = rateAt(m, phx(2026, 3, 4, 2));
    assert.equal(r.periodId, 'night');
    assert.equal(r.centsPerKwh, 0, 'free, not unknown');
    assert.equal(hourlyRateCents(phx(2026, 3, 4, 2), { onPeak: 99, offPeak: 99 }), 0);
    assert.equal(rateAt(m, phx(2026, 7, 8, 18)).centsPerKwh, 40);
    assert.equal(rateAt(m, phx(2026, 1, 7, 18)).centsPerKwh, 30);
    // The night charge resolves the plan's own cheap window.
    const w = resolveCheapWindow((t) => rateAt(m, t).periodId, phx(2026, 3, 4, 21, 30), cheapPeriodIdOf(m)!, 30);
    assert.deepEqual(w, { startMs: phx(2026, 3, 5, 0), endMs: phx(2026, 3, 5, 6) });
    // The legacy fallback window is the plan's on-peak period.
    assert.deepEqual(legacyOnPeakWindow(m), { hours: '17-21', days: '1-5' });
    assert.deepEqual(resolveTariffCents(phx(2026, 7, 8, 12)), { onPeak: 40, offPeak: 20, basis: 'custom-summer' });
  });
});

/* ── P5: an unusable spec fails closed, never APS ─────────────────────────────────────────── */

const INVALID: Array<[string, Record<string, string>, RegExp]> = [
  ['a period without its season', { ...CUSTOM, TARIFF_PERIODS: 'peak 17-21 mon-fri' }, /TARIFF_PERIODS.*needs <id> <hours> <days> <season>/],
  ['a period with no rate', { ...CUSTOM, TARIFF_RATES: 'off_peak=20' }, /no rate for peak/],
  ['an unknown plan', { TARIFF_PLAN: 'tou' }, /TARIFF_PLAN: "tou" is not one of/],
  ['TARIFF_PERIODS without TARIFF_PLAN custom', { TARIFF_PERIODS: CUSTOM.TARIFF_PERIODS, TARIFF_RATES: CUSTOM.TARIFF_RATES }, /TARIFF_PERIODS is set but TARIFF_PLAN is aps_r_ev/],
  ['a month that does not exist', { TARIFF_SUMMER_MONTHS: '4-13' }, /TARIFF_SUMMER_MONTHS: "13" is not a month/],
  ['a date that does not exist', { TARIFF_HOLIDAYS: '2027-02-30' }, /TARIFF_HOLIDAYS: "2027-02-30"/],
  ['a fixed charge that is not a number', { TARIFF_FIXED_DAILY_CENTS: 'abc' }, /TARIFF_FIXED_DAILY_CENTS/],
  ['a cheap period the plan does not have', { NIGHT_CHARGE_CHEAP_PERIOD: 'midday' }, /NIGHT_CHARGE_CHEAP_PERIOD: "midday" is not a period of the aps_r_ev plan/],
  ['a custom plan without periods', { TARIFF_PLAN: 'custom', TARIFF_RATES: 'off_peak=20' }, /custom needs TARIFF_PERIODS/],
];

test('★★★ P5: an unusable tariff spec nulls the money, holds the night charge, raises a repair issue — never the APS table', () => {
  for (const [what, env, why] of INVALID) {
    withEnv({ ...CONFIRMED_APS, ...env }, () => {
      const r = resolveTariffFromEnv();
      assert.match(r.error ?? '', why, what);
      const m = tariffModelFromEnv();
      assert.equal(m.planId, 'invalid', what);
      assert.notDeepStrictEqual(m, buildApsREvModel(apsREvRatesFromEnv()), `${what}: never silently APS`);
      assert.equal(m.ratesConfirmed, false, what);
      assert.equal(m.periods.length, 0, what);
      // Null money: a confirmed on-peak hour prices nothing, and is not on-peak.
      const onPeak = rateAt(m, phx(2026, 7, 15, 17));
      assert.equal(onPeak.centsPerKwh, null, what);
      assert.equal(onPeak.isOnPeak, false, what);
      // The night charge holds: no cheap window resolves (nightChargeAdvisor: "no valid cheap charge window").
      assert.equal(cheapPeriodIdOf(m), null, what);
      assert.equal(resolveCheapWindow((t) => rateAt(m, t).periodId, phx(2026, 7, 15, 21, 30), APS_PERIOD.OVERNIGHT, 30), null, what);
      // The cost figures fall to the flat ladder an unconfirmed install uses.
      assert.equal(resolveTariffCents(phx(2026, 7, 15, 12)).basis, 'flat-default', what);
      const issues = tariffRepairIssues();
      assert.equal(issues.length, 1, what);
      assert.equal(issues[0].id, TARIFF_SPEC_ISSUE_ID);
      assert.equal(issues[0].category, 'Configuration');
      assert.ok(issues[0].summary.includes(r.error!), what);
    });
  }
});

/* ── currency (S5c, CA14) ──────────────────────────────────────────────────────────────────── */

test('★★★ G7 parity: with TARIFF_CURRENCY unset every discovery payload is the table\'s own (USD)', () => {
  withEnv({}, () => {
    assert.deepEqual(tariffCurrency(), { code: 'USD', set: false, error: null });
    for (const s of SENSORS) {
      assert.equal(JSON.stringify(sensorDiscoveryConfig(s)), JSON.stringify(sensorDiscoveryConfig(s, 'USD')), s.unique_id);
      assert.equal(sensorDiscoveryConfig(s).unit_of_measurement, s.unit_of_measurement, s.unique_id);
    }
  });
});

test('★★★ EUR units: the money sensors and the rate follow TARIFF_CURRENCY; unique_ids and every other unit do not', () => {
  withEnv({ TARIFF_CURRENCY: 'eur' }, () => {
    assert.deepEqual(tariffCurrency(), { code: 'EUR', set: true, error: null });
    const byId = new Map(SENSORS.map((s) => [s.unique_id, sensorDiscoveryConfig(s)]));
    for (const id of ['ecoflow_tariff_today_cost', 'ecoflow_tariff_today_saved', 'ecoflow_tariff_savings_7d']) assert.equal(byId.get(id)!.unit_of_measurement, 'EUR', id);
    assert.equal(byId.get('ecoflow_grid_price_now')!.unit_of_measurement, 'EUR/kWh');
    for (const s of SENSORS) {
      const cfg = sensorDiscoveryConfig(s);
      assert.equal(cfg.unique_id, s.unique_id);
      if (s.unit_of_measurement !== 'USD' && s.unit_of_measurement !== 'USD/kWh') assert.equal(cfg.unit_of_measurement, s.unit_of_measurement, s.unique_id);
      const { unit_of_measurement: _a, ...restCfg } = cfg;
      const { unit_of_measurement: _b, ...restUsd } = sensorDiscoveryConfig(s, 'USD');
      assert.deepEqual(restCfg, restUsd, `${s.unique_id}: only the unit changes`);
    }
    assert.deepEqual(auditDiscoveryTables(sensorsInCurrency('EUR'), BINARY_SENSORS), [], 'the EUR table passes the discovery invariants');
  });
  for (const c of CURRENCIES) assert.deepEqual(auditDiscoveryTables(sensorsInCurrency(c), BINARY_SENSORS), [], c);
});

test('★★ an unknown currency keeps USD and raises a repair issue', () => {
  withEnv({ TARIFF_CURRENCY: 'XYZ' }, () => {
    const c = tariffCurrency();
    assert.equal(c.code, 'USD');
    assert.match(c.error!, /TARIFF_CURRENCY "XYZ" is not one of USD, EUR, GBP, CAD, AUD/);
    assert.equal(sensorDiscoveryConfig(SENSORS.find((s) => s.unique_id === 'ecoflow_tariff_today_cost')!).unit_of_measurement, 'USD');
    assert.deepEqual(tariffRepairIssues().map((i) => i.id), [TARIFF_CURRENCY_ISSUE_ID]);
  });
});

test('★★ CA14: one money formatter — "$" and "¢" when unset (today\'s text), the currency\'s symbols when set', () => {
  withEnv({}, () => {
    assert.equal(fmtMoney(1.889), '$1.89');
    assert.equal(fmtMoney(-1.5), '$-1.50', 'the sign placement is the text\'s own');
    assert.equal(fmtMinor(1234), '1234¢');
  });
  withEnv({ TARIFF_CURRENCY: 'EUR' }, () => { assert.equal(fmtMoney(1.889), '€1.89'); assert.equal(fmtMinor(1234), '1234c'); });
  withEnv({ TARIFF_CURRENCY: 'GBP' }, () => { assert.equal(fmtMoney(2), '£2.00'); assert.equal(fmtMinor(7), '7p'); });
});

const VERDICT = {
  active: true, gridToBatteryW: 4_000, onPeak: true, periodLabel: 'On-Peak (4–7pm Mon–Fri)', centsPerHour: 176.8, heldForMs: 20 * 60_000,
  suppressed: null, coreAttribution: null, forceChargeOn: [],
} as unknown as PeakDrawVerdict;

test('★★ the peak-draw alert, the MPC rationale and the score note keep today\'s text when TARIFF_CURRENCY is unset', () => {
  withEnv({}, () => {
    const [a] = peakGridDrawAlerts(VERDICT, phx(2026, 7, 15, 17, 20));
    assert.ok(a.detail.includes('that is about $1.77 per hour.'), a.detail);
    assert.equal(a.facts!.find((f) => f.label === 'Cost rate')!.value, '$1.77/h');
    const notes = recommendDispatch(MPC_FLAT).notes;
    assert.ok(notes.some((n) => /^Baseline \(no MPC\) projected cost: \$-?\d+\.\d\d; optimized: \$-?\d+\.\d\d$/.test(n)), notes.join(' | '));
    assert.ok(notes.some((n) => n.endsWith('Reporting $0 expected savings.')), notes.join(' | '));
  });
  withEnv({ TARIFF_CURRENCY: 'EUR' }, () => {
    const [a] = peakGridDrawAlerts(VERDICT, phx(2026, 7, 15, 17, 20));
    assert.ok(a.detail.includes('that is about €1.77 per hour.'));
    assert.ok(recommendDispatch(MPC_FLAT).notes.some((n) => n.endsWith('Reporting €0 expected savings.')));
  });
});

const MPC_FLAT: MpcInputs = {
  currentSocPct: 60, reserveFloorPct: 20, capacityKwh: 60,
  pvForecastP50: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 4.0 : 0)),
  pvForecastP10: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 2.5 : 0)),
  loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 22 ? 2.0 : 1.0)),
  tariffOnPeakCentsByHour: new Array(24).fill(17),
  gridAvailable: true, cyclingCostUsdPerKwh: 0.02, reserveDipPenaltyUsdPerKwh: 1.0,
};

test('★★ the score note (persisted in score_notes) is unchanged when unset, and names the confirmation option in effect', () => {
  const span = { startMs: phx(2026, 3, 4, 23), endMs: phx(2026, 3, 5, 1) };
  const pts = Array.from({ length: 121 }, (_, i) => ({ ts: span.startMs + i * 60_000, value: 1_000 }));
  withEnv({}, () => {
    const priced = realizedCostOutcome({ span, supersededBy: null, pts, rateAt: () => ({ centsPerKwh: 10 }) });
    assert.match(priced.note, /^Cost: \d+¢ of metered import, window open to close \+ 16 h/);
    const unconfirmed = realizedCostOutcome({ span, supersededBy: null, pts, rateAt: () => ({ centsPerKwh: null, ratesConfirmed: false }) });
    assert.equal(unconfirmed.note, 'Cost: not priced (tariff rates unconfirmed — TARIFF_APS_RATES_CONFIRMED)');
  });
  withEnv({ TARIFF_RATES_CONFIRMED: 'false' }, () => {
    const unconfirmed = realizedCostOutcome({ span, supersededBy: null, pts, rateAt: () => ({ centsPerKwh: null, ratesConfirmed: false }) });
    assert.equal(unconfirmed.note, 'Cost: not priced (tariff rates unconfirmed — TARIFF_RATES_CONFIRMED)');
  });
  withEnv({ TARIFF_CURRENCY: 'GBP' }, () => {
    const priced = realizedCostOutcome({ span, supersededBy: null, pts, rateAt: () => ({ centsPerKwh: 10 }) });
    assert.match(priced.note, /^Cost: \d+p of metered import/);
  });
});

test('GET /api/site: the currency field follows TARIFF_CURRENCY (USD when unset)', () => {
  withEnv({}, () => assert.equal(siteResponse({}).currency, 'USD'));
  withEnv({ TARIFF_CURRENCY: 'CAD' }, () => assert.equal(siteResponse({}).currency, 'CAD'));
});

/* ── the bridge: each new key is a schema-only option, exported only when set ─────────────── */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NEW_KEYS: Record<string, string> = {
  TARIFF_PLAN: 'list(aps_r_ev|flat|two_tier|custom)?', TARIFF_PERIODS: 'str?', TARIFF_RATES: 'str?', TARIFF_RATES_CONFIRMED: 'bool?',
  TARIFF_FIXED_DAILY_CENTS: 'float?', TARIFF_SUMMER_MONTHS: 'str?', TARIFF_HOLIDAYS: 'str?', TARIFF_CURRENCY: 'str?',
  NIGHT_CHARGE_CHEAP_PERIOD: 'str?', TARIFF_FLAT_CENTS_PER_KWH: 'float?', TARIFF_ON_PEAK_CENTS: 'float?', TARIFF_OFF_PEAK_CENTS: 'float?',
  TARIFF_EXPORT_CENTS_PER_KWH: 'float?', TARIFF_ON_PEAK_HOURS: 'str?', TARIFF_ON_PEAK_DAYS: 'str?',
};

test('★★ the 15 tariff keys are schema-only (no options: default), exported under has_value, translated, documented', () => {
  const cfg = readFileSync(resolve(ROOT, 'ecoflow_panel/config.yaml'), 'utf8');
  const run = readFileSync(resolve(ROOT, 'rootfs/etc/services.d/ecoflow-panel/run'), 'utf8');
  const optionsBlock = cfg.slice(cfg.indexOf('\noptions:'), cfg.indexOf('\nschema:'));
  const schemaBlock = cfg.slice(cfg.indexOf('\nschema:'));
  const md = readFileSync(resolve(ROOT, 'docs/guide/options.md'), 'utf8');
  for (const [key, schema] of Object.entries(NEW_KEYS)) {
    assert.ok(!new RegExp(`^  ${key}:`, 'm').test(optionsBlock), `${key} must have no options: default (CA3 / DECISION 20)`);
    assert.ok(schemaBlock.includes(`\n  ${key}: "${schema}"\n`), `${key}: schema ${schema}`);
    assert.ok(run.includes(`if bashio::config.has_value '${key}'; then export ${key}="$(bashio::config '${key}')"; fi`), `${key}: has_value export`);
    for (const lang of ['en', 'es']) {
      const t = readFileSync(resolve(ROOT, `ecoflow_panel/translations/${lang}.yaml`), 'utf8');
      assert.ok(t.includes(`\n  ${key}:\n    name: `), `${key}: ${lang} entry`);
    }
    assert.ok(md.includes(`| \`${key}\` | unset (behaves as `), `${key}: options.md row`);
    const row = OPTIONS[key];
    assert.equal(row.source, 'option', key);
    assert.equal(row.exportForm, 'has_value', key);
  }
  // The MPC names stay environment-only aliases (no option of their own).
  for (const key of ['TARIFF_ON_PEAK_CENTS_PER_KWH', 'TARIFF_OFF_PEAK_CENTS_PER_KWH']) {
    assert.equal(OPTIONS[key].source, 'env-only');
    assert.ok(!schemaBlock.includes(`\n  ${key}:`), key);
  }
  // R7: the APS block's comment names the preset, and the heartbeat keys have their own heading.
  assert.ok(cfg.includes('# APS R-EV preset (used when TARIFF_PLAN is unset or aps_r_ev)'));
  assert.ok(cfg.includes('# Heartbeat (dead-man\'s switch)'));
});

/* ── index.ts wiring (index.ts starts the server, so its wiring is pinned at the source) ───── */

test('★★ index.ts: every tariff read is the plan in effect; the MPC pair is the legacy reader; the repair issues and the boot line are raised', () => {
  const idx = readFileSync(resolve(ROOT, 'server/src/index.ts'), 'utf8');
  assert.ok(!idx.includes('apsREvModelFromEnv'), 'no index.ts call site reads the APS-only alias');
  // v1.191.0 (S6) — plus nightScheduleNow's default argument: the schedule is the plan in effect's too.
  assert.equal((idx.match(/tariffModelFromEnv\(\)/g) ?? []).length, 11, 'the ten index.ts call sites and the schedule\'s default');
  assert.ok(idx.includes('function nightScheduleNow(model = tariffModelFromEnv()): NightSchedule {'));
  assert.ok(!/process\.env\.TARIFF_/.test(idx), 'no tariff setting is read from the environment in index.ts');
  // The MPC vector's fallback pair: analytics.ts mpcFallbackPair (the MPC names with their own rule while
  // TARIFF_PLAN is unset; the cost figures' pair once a plan is set, review 3); the flat rate from the ladder.
  assert.ok(idx.includes('  const legacyTariff = legacyTariffFromEnv();\n  const flatCents = legacyTariff.flatCents;\n  const { onPeak, offPeak } = mpcFallbackPair(Date.now());'));
  assert.ok(idx.includes('    hourlyRateCents(zonedWallTimeMs(todayYmd, h, 0, siteTimeZone()), { onPeak, offPeak }));'), 'the vector is priced with that pair');
  assert.ok(!idx.includes('legacyTariff.mpc'), 'no second reader of the MPC pair');
  // P5: the route serves the tariff issues beside the others.
  const routeAt = idx.indexOf("app.get('/api/repair-issues'");
  const route = idx.slice(routeAt, idx.indexOf('return cached(req, reply, { ...report, issues: [...report.issues, ...siteRepairIssues()] }, 60);', routeAt));
  assert.ok(routeAt > 0 && route.includes('  report.issues.push(...tariffRepairIssues(report.generatedAt));\n'), 'the route pushes the tariff issues before it returns the report');
  // The boot line names the plan, or the fault.
  assert.ok(idx.includes('  const t = resolveTariffFromEnv();\n  if (t.error != null) {\n    app.log.error(`tariff: ${t.error}'));
  // CA20's tariff half is part of the one reference-home-defaults notice (site.ts siteBootNotices, judged on
  // the resolved site zone): index.ts logs no second copy, and site.ts reads TARIFF_PLAN for it.
  assert.ok(!idx.includes('referenceHomeTariffNotice('), 'one reference-home notice, not a second tariff line');
  assert.ok(idx.includes('siteBootNotices(siteLog, { rosterSize: lastKnownRoster.size });'));
  const site = readFileSync(resolve(ROOT, 'server/src/site.ts'), 'utf8');
  assert.ok(site.includes("export const tariffPlanUnsetInput = (): boolean => option<string | null>('TARIFF_PLAN') == null;"));
  assert.ok(site.includes('export const siteZoneInput = (): string => siteTimeZone();'));
  // The stale "the operator's APS plan is flat" comment is gone.
  assert.ok(!idx.includes("the operator's APS plan is flat"));
});
