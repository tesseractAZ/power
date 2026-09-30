/**
 * v1.187.0 — /api/tariff reports the window and the rates that actually PRICE the kWh.
 *
 * Live (2026-09-29, TARIFF_APS_RATES_CONFIRMED=true): the report said onPeakHours "15-20"
 * (the TARIFF_ON_PEAK_HOURS default, which the add-on offers no option to set) while every
 * priced and gated path used R-EV's 16:00-19:00 — HA's rate-now sensor switched to 0.442 at
 * 16:00:27 and back at 19:00:29 — and the 12.59¢ overnight rate that priced every
 * overnight kWh appeared nowhere in it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  tariffPricingView, computeTariffReport, isOnPeakHour, resetHaStateShortLivedCaches,
} from '../src/analytics.js';
import { buildApsREvModel, onPeakWindowStrings, rateAt, type TariffModel } from '../src/tariff.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const phx = (y: number, mo: number, d: number, h: number) => Date.UTC(y, mo - 1, d, h + 7);
const SEP = phx(2026, 9, 29, 12);
const JAN = phx(2027, 1, 12, 12);
const REV = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 44.2, winter: 30.1 },
  offPeak: { summer: 16.91, winter: 11.2 },
  overnight: { summer: 12.59, winter: 12.59 },
  superOffPeak: { summer: null, winter: 8.2 },
});
const LEGACY = { hours: '15-20', days: '1-5' };
const FALLBACK = { onPeak: 44.2, offPeak: 16.91 };

test('★★★ THE DEFECT: a confirmed R-EV table reports 16-19 Mon-Fri and its overnight rate', () => {
  const v = tariffPricingView(REV, SEP, FALLBACK, LEGACY);
  assert.equal(v.onPeakHours, '16-19');
  assert.equal(v.onPeakDays, '1-5');
  assert.equal(v.onPeakCents, 44.2);
  assert.equal(v.offPeakCents, 16.91);
  assert.equal(v.overnightCents, 12.59, 'the rate that priced every overnight kWh is reported');
  assert.equal(v.superOffPeakCents, null, 'summer: the winter tier is not in effect');
  assert.equal(v.pricingBasis, 'rate-table');
});

test('winter reports the super-off-peak tier and the winter rates', () => {
  const v = tariffPricingView(REV, JAN, FALLBACK, LEGACY);
  assert.deepEqual([v.onPeakCents, v.offPeakCents, v.overnightCents, v.superOffPeakCents], [30.1, 11.2, 12.59, 8.2]);
});

test('an unconfirmed install reports the two-tier pair and the legacy window it is priced with', () => {
  const v = tariffPricingView(buildApsREvModel(), SEP, { onPeak: 17, offPeak: 17 }, LEGACY);
  assert.deepEqual([v.onPeakHours, v.onPeakDays, v.onPeakCents, v.offPeakCents, v.overnightCents, v.pricingBasis],
    ['15-20', '1-5', 17, 17, null, 'two-tier']);
});

test('a confirmed table missing a period rate reports the fallback hourlyRateCents would use', () => {
  const partial = buildApsREvModel({ confirmed: true, offPeak: { summer: 16.91, winter: 11.2 } });
  const v = tariffPricingView(partial, SEP, { onPeak: 40, offPeak: 15 }, LEGACY);
  assert.equal(v.onPeakCents, 40);
  assert.equal(v.offPeakCents, 16.91);
  assert.equal(v.overnightCents, null);
});

test('onPeakWindowStrings maps the model\'s 0=Sun weekdays onto the report\'s 1=Mon scale', () => {
  assert.deepEqual(onPeakWindowStrings(REV), { hours: '16-19', days: '1-5' });
  const weekendOnly: TariffModel = { ...REV, periods: [{ ...REV.periods[0], weekdays: [0, 6] }] };
  assert.deepEqual(onPeakWindowStrings(weekendOnly), { hours: '16-19', days: '6-7' });
  const split: TariffModel = { ...REV, periods: [{ ...REV.periods[0], weekdays: [1, 3, 5] }] };
  assert.equal(onPeakWindowStrings(split)!.days, '1,3,5', 'a non-contiguous set is listed, not bent into a range');
  const everyDay: TariffModel = { ...REV, periods: [{ ...REV.periods[0], weekdays: null }] };
  assert.equal(onPeakWindowStrings(everyDay)!.days, '1-7');
  assert.equal(onPeakWindowStrings({ ...REV, periods: [] }), null);
});

/* ── the report agrees with the gate, hour by hour ────────────────────────── */
const KEYS = ['TARIFF_APS_RATES_CONFIRMED', 'TARIFF_APS_ONPEAK_SUMMER_CENTS', 'TARIFF_APS_OFFPEAK_SUMMER_CENTS',
  'TARIFF_APS_OVERNIGHT_CENTS', 'TARIFF_APS_ONPEAK_WINTER_CENTS', 'TARIFF_APS_OFFPEAK_WINTER_CENTS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } });

test('★★ with the live configuration, computeTariffReport states what isOnPeakHour and the rates do', () => {
  process.env.TARIFF_APS_RATES_CONFIRMED = 'true';
  process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.2';
  process.env.TARIFF_APS_OFFPEAK_SUMMER_CENTS = '16.91';
  process.env.TARIFF_APS_OVERNIGHT_CENTS = '12.59';
  process.env.TARIFF_APS_ONPEAK_WINTER_CENTS = '30.1';
  process.env.TARIFF_APS_OFFPEAK_WINTER_CENTS = '11.2';
  resetHaStateShortLivedCaches();
  const tr = computeTariffReport({}, makeRecorderStub({}));
  assert.equal(tr.onPeakHours, '16-19');
  assert.equal(tr.onPeakDays, '1-5');
  assert.equal(tr.pricingBasis, 'rate-table');
  assert.equal(tr.tariffBasis?.startsWith('aps_r_ev-'), true, 'tariffBasis keeps naming the two-tier tier');
  // The report's window is exactly the hours the gate calls on-peak, every hour of a week.
  const [h0, h1] = tr.onPeakHours.split('-').map(Number);
  const [d0, d1] = tr.onPeakDays.split('-').map(Number);
  for (let h = 0; h < 7 * 24; h++) {
    const t = phx(2026, 9, 28, 0) + h * 3_600_000;
    const hour = h % 24;
    const dowMon1 = ((Math.floor(h / 24) + 1 - 1) % 7) + 1; // 2026-09-28 is a Monday
    const reported = hour >= h0 && hour < h1 && dowMon1 >= d0 && dowMon1 <= d1;
    assert.equal(isOnPeakHour(t), reported, `hour ${h}`);
    assert.equal(rateAt(buildApsREvModel({ confirmed: true }), t).isOnPeak, reported);
  }
});
