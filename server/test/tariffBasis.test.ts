import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTariffCents } from '../src/analytics.js';

/* v1.52.0 — the cost engine must price kWh off the CONFIRMED tariff, not the
 * stale v0.9.58 flat-rate assumption. A flat 17¢ while the night-charge planner
 * uses APS R-EV at 44.4¢ on-peak is two engines disagreeing about the same
 * kilowatt-hour, with the money KPIs computed off the wrong one. */

const JUL = Date.UTC(2026, 6, 15, 19, 0); // July = APS summer
const JAN = Date.UTC(2026, 0, 15, 19, 0); // January = APS winter
const KEYS = ['TARIFF_ON_PEAK_CENTS','TARIFF_OFF_PEAK_CENTS','TARIFF_APS_RATES_CONFIRMED',
  'TARIFF_APS_ONPEAK_SUMMER_CENTS','TARIFF_APS_OFFPEAK_SUMMER_CENTS',
  'TARIFF_APS_ONPEAK_WINTER_CENTS','TARIFF_APS_OFFPEAK_WINTER_CENTS'];
function clear() { for (const k of KEYS) delete process.env[k]; }

test('unconfigured install keeps the flat default (no behavior change)', () => {
  clear();
  const r = resolveTariffCents(JUL);
  assert.equal(r.onPeak, 17); assert.equal(r.offPeak, 17); assert.equal(r.basis, 'flat-default');
});

test('confirmed APS R-EV rates drive the cost basis, seasonally', () => {
  clear();
  process.env.TARIFF_APS_RATES_CONFIRMED = 'true';
  process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.4';
  process.env.TARIFF_APS_OFFPEAK_SUMMER_CENTS = '11.6';
  process.env.TARIFF_APS_ONPEAK_WINTER_CENTS = '23.1';
  process.env.TARIFF_APS_OFFPEAK_WINTER_CENTS = '10.2';
  const s = resolveTariffCents(JUL);
  assert.equal(s.onPeak, 44.4); assert.equal(s.offPeak, 11.6); assert.equal(s.basis, 'aps_r_ev-summer');
  const w = resolveTariffCents(JAN);
  assert.equal(w.onPeak, 23.1); assert.equal(w.offPeak, 10.2); assert.equal(w.basis, 'aps_r_ev-winter');
  clear();
});

test('UNCONFIRMED APS rates are never used — no fabricated price', () => {
  clear();
  process.env.TARIFF_APS_RATES_CONFIRMED = 'false';
  process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.4';
  process.env.TARIFF_APS_OFFPEAK_SUMMER_CENTS = '11.6';
  const r = resolveTariffCents(JUL);
  assert.equal(r.basis, 'flat-default'); assert.equal(r.onPeak, 17);
  clear();
});

test('explicit overrides win over everything', () => {
  clear();
  process.env.TARIFF_ON_PEAK_CENTS = '30';
  process.env.TARIFF_OFF_PEAK_CENTS = '8';
  process.env.TARIFF_APS_RATES_CONFIRMED = 'true';
  process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.4';
  process.env.TARIFF_APS_OFFPEAK_SUMMER_CENTS = '11.6';
  const r = resolveTariffCents(JUL);
  assert.equal(r.onPeak, 30); assert.equal(r.offPeak, 8); assert.equal(r.basis, 'explicit-override');
  clear();
});

test('a partial/garbage APS table falls back rather than half-pricing', () => {
  clear();
  process.env.TARIFF_APS_RATES_CONFIRMED = 'true';
  process.env.TARIFF_APS_ONPEAK_SUMMER_CENTS = '44.4';   // off-peak missing
  const r = resolveTariffCents(JUL);
  assert.equal(r.basis, 'flat-default');
  clear();
});
