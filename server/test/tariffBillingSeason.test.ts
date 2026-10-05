import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecorderStub } from './helpers/recorderStub.js';

/**
 * v1.187.10 — the APS season follows the BILLING CYCLE, from one season source.
 *
 * APS bills May–October at summer rates and November–April at winter rates. A bill covers the
 * usage since the previous meter read, early in the month, so summer USAGE runs from the
 * early-April read to the early-October read. tariff.ts seasoned by calendar month with
 * [5..10] and analytics.ts carried its own May–October test, so October usage — billed at
 * winter rates since the 2026-10-02 notice — was priced as summer: live /api/tariff on
 * 2026-10-04 read basis aps_r_ev-summer, on-peak 44.2 c and superOffPeakCents null, and the
 * winter 10:00–15:00 super-off-peak tier never priced an October kWh. Both now read
 * `seasonAt` (usage months Apr–Sep summer, Oct–Mar winter).
 *
 * The cents below are fixture values (the configured numbers are unchanged by the fix).
 */

const CONFIRMED = {
  TARIFF_APS_RATES_CONFIRMED: 'true',
  TARIFF_APS_ONPEAK_SUMMER_CENTS: '44.20',
  TARIFF_APS_ONPEAK_WINTER_CENTS: '39.5',
  TARIFF_APS_OFFPEAK_SUMMER_CENTS: '16.91',
  TARIFF_APS_OFFPEAK_WINTER_CENTS: '17.0',
  TARIFF_APS_OVERNIGHT_CENTS: '12.59',
  TARIFF_APS_SUPEROFFPEAK_WINTER_CENTS: '8.2',
};
const withEnv = async <T>(env: Record<string, string>, fn: () => Promise<T> | T): Promise<T> => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
/** A UTC ms for a Phoenix (UTC-7, no DST) wall-clock. */
const phx = (iso: string) => new Date(`${iso}-07:00`).getTime();

const BOUNDARIES: Array<[string, string, 'summer' | 'winter']> = [
  ['Wed Sep 30 23:59 — last summer usage day', '2026-09-30T23:59:00', 'summer'],
  ['Thu Oct 1 00:00 — winter usage (November bill)', '2026-10-01T00:00:00', 'winter'],
  ['Tue Mar 31 23:59 — last winter usage day', '2026-03-31T23:59:00', 'winter'],
  ['Wed Apr 1 00:00 — summer usage (May bill)', '2026-04-01T00:00:00', 'summer'],
];

test('★★★ the season boundaries: Sep 30 summer / Oct 1 winter, Mar 31 winter / Apr 1 summer', async () => {
  const { seasonAt, apsREvModelFromEnv, APS_SUMMER_MONTHS } = await import('../src/tariff.js');
  assert.deepEqual(APS_SUMMER_MONTHS, [4, 5, 6, 7, 8, 9], 'usage months Apr–Sep are summer');
  const model = apsREvModelFromEnv();
  for (const [name, iso, want] of BOUNDARIES) assert.equal(seasonAt(model, phx(iso)), want, name);
  assert.equal(seasonAt(model, phx('2026-10-15T12:00:00')), 'winter', 'mid-October');
  assert.equal(seasonAt(model, phx('2026-07-15T12:00:00')), 'summer', 'July');
  assert.equal(seasonAt(model, phx('2027-01-15T12:00:00')), 'winter', 'January');
  // The boundary is the LOCAL month: 2026-10-01 06:59 UTC is still Sep 30 23:59 in Phoenix.
  assert.equal(seasonAt(model, Date.UTC(2026, 9, 1, 6, 59)), 'summer', 'Sep 30 23:59 Phoenix');
});

test('★★★ the two-tier basis (analytics) reads the same season at the boundaries', async () => {
  const { apsSeasonIsSummer } = await import('../src/analytics.js');
  for (const [name, iso, want] of BOUNDARIES) assert.equal(apsSeasonIsSummer(phx(iso)), want === 'summer', name);
});

test('★★★ October prices at winter rates, with the 10:00–15:00 super-off-peak tier', async () => {
  await withEnv(CONFIRMED, async () => {
    const { rateAt, apsREvModelFromEnv } = await import('../src/tariff.js');
    const { hourlyRateCents } = await import('../src/analytics.js');
    const m = apsREvModelFromEnv();
    const f = { onPeak: 99, offPeak: 98 }; // never reached on a confirmed table
    const cases: Array<[string, string, string, 'summer' | 'winter', number]> = [
      ['Thu Oct 1 12:00', '2026-10-01T12:00:00', 'super_off_peak', 'winter', 8.2],
      ['Thu Oct 1 17:00', '2026-10-01T17:00:00', 'on_peak', 'winter', 39.5],
      ['Thu Oct 1 20:00', '2026-10-01T20:00:00', 'off_peak', 'winter', 17.0],
      ['Wed Sep 30 12:00', '2026-09-30T12:00:00', 'off_peak', 'summer', 16.91],
      ['Wed Sep 30 17:00', '2026-09-30T17:00:00', 'on_peak', 'summer', 44.2],
      ['Tue Mar 31 12:00', '2026-03-31T12:00:00', 'super_off_peak', 'winter', 8.2],
      ['Wed Apr 1 12:00', '2026-04-01T12:00:00', 'off_peak', 'summer', 16.91],
      ['Wed Apr 1 17:00', '2026-04-01T17:00:00', 'on_peak', 'summer', 44.2],
    ];
    for (const [name, iso, period, season, cents] of cases) {
      const r = rateAt(m, phx(iso));
      assert.equal(r.periodId, period, `${name}: period`);
      assert.equal(r.season, season, `${name}: season`);
      assert.equal(r.centsPerKwh, cents, `${name}: rate`);
      assert.equal(hourlyRateCents(phx(iso), f), cents, `${name}: the KPI tally's hourly rate`);
    }
  });
});

test('★★★ /api/tariff resolution on 2026-10-04: winter basis, winter on-peak, super-off-peak priced', async () => {
  await withEnv(CONFIRMED, async () => {
    const { resolveTariffCents, tariffPricingView } = await import('../src/analytics.js');
    const { apsREvModelFromEnv } = await import('../src/tariff.js');
    const legacy = { hours: '15-20', days: '1-5' };
    const oct = phx('2026-10-04T12:00:00');
    const two = resolveTariffCents(oct);
    assert.equal(two.basis, 'aps_r_ev-winter');
    assert.deepEqual([two.onPeak, two.offPeak], [39.5, 17.0]);
    const v = tariffPricingView(apsREvModelFromEnv(), oct, two, legacy);
    assert.equal(v.superOffPeakCents, 8.2, 'the winter tier is in season in October');
    assert.equal(v.onPeakCents, 39.5);
    assert.equal(v.offPeakCents, 17.0);
    assert.equal(v.overnightCents, 12.59);

    const sep = phx('2026-09-30T12:00:00');
    const twoS = resolveTariffCents(sep);
    assert.equal(twoS.basis, 'aps_r_ev-summer');
    const vS = tariffPricingView(apsREvModelFromEnv(), sep, twoS, legacy);
    assert.equal(vS.superOffPeakCents, null, 'no super-off-peak in summer');
    assert.equal(vS.onPeakCents, 44.2);
  });
});

test('★★ the report itself (computeTariffReport) on 2026-10-04 states the winter rates', async () => {
  await withEnv(CONFIRMED, async () => {
    mock.timers.enable({ apis: ['Date'], now: phx('2026-10-04T12:00:00') });
    try {
      const { computeTariffReport } = await import('../src/analytics.js');
      const r = computeTariffReport({}, makeRecorderStub());
      assert.equal(r.tariffBasis, 'aps_r_ev-winter');
      assert.equal(r.superOffPeakCents, 8.2);
      assert.equal(r.onPeakCents, 39.5);
    } finally {
      mock.timers.reset();
    }
  });
});

test('★★ ONE season source: every day of the year, the rate table and the two-tier basis agree', async () => {
  await withEnv(CONFIRMED, async () => {
    const { rateAt, apsREvModelFromEnv, seasonAt } = await import('../src/tariff.js');
    const { apsSeasonIsSummer, resolveTariffCents } = await import('../src/analytics.js');
    const m = apsREvModelFromEnv();
    for (let d = 0; d < 366; d++) {
      for (const h of [0, 12, 23]) {
        const ts = phx('2026-01-01T00:00:00') + d * 86_400_000 + h * 3_600_000;
        const s = seasonAt(m, ts);
        assert.equal(rateAt(m, ts).season, s, `rateAt day ${d} h ${h}`);
        assert.equal(apsSeasonIsSummer(ts), s === 'summer', `apsSeasonIsSummer day ${d} h ${h}`);
        assert.equal(resolveTariffCents(ts).basis, `aps_r_ev-${s}`, `resolveTariffCents day ${d} h ${h}`);
      }
    }
  });
});

test('SOURCE PIN: the nightly plan\'s tariff snapshot and the report view read seasonAt', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const idx = readFileSync(resolve(here, '../src/index.ts'), 'utf8');
  const an = readFileSync(resolve(here, '../src/analytics.ts'), 'utf8');
  assert.match(idx, /const season = seasonAt\(tariffModel, nowMs\);[^\n]*\n\s*const tariffSnapshot = JSON\.stringify\(\{/);
  assert.doesNotMatch(idx, /seasonOf\(/, 'index.ts derives no season of its own');
  assert.doesNotMatch(an, /seasonOf\(|summerMonths/, 'analytics.ts derives no season of its own');
});
