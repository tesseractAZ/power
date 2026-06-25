import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fadeExceedsPlausibleCeiling } from '../src/analytics.js';

// v0.64.0 — the DATED-EOL projection must reject an OLS fade rate that is physically
// implausible for healthy LFP (≈2-3 %/yr). Live regression: Core 3 packs 4 & 5 read
// 95 % SoH yet fit 38.99 / 43.25 %/yr over a 30-day window (early-life BMS fullCap
// settling, NOT real fade), dating a false ~0.4 yr EOL that propagated to the
// soonest-EOL HA sensor. fadeExceedsPlausibleCeiling mirrors the forecast-soh ALERT
// path's MAX_SOH_FADE_PCT_PER_YEAR (10 %/yr) so the projection can't outrun the alert.

test('fadeExceedsPlausibleCeiling — TRUE for the live Core 3 pack 4 fade (38.99 %/yr)', () => {
  assert.equal(fadeExceedsPlausibleCeiling(38.99), true);
});

test('fadeExceedsPlausibleCeiling — TRUE for the live Core 3 pack 5 fade (43.25 %/yr)', () => {
  assert.equal(fadeExceedsPlausibleCeiling(43.25), true);
});

test('fadeExceedsPlausibleCeiling — TRUE just above the 10 %/yr ceiling', () => {
  assert.equal(fadeExceedsPlausibleCeiling(10.01), true);
});

test('fadeExceedsPlausibleCeiling — FALSE at the ceiling (a fast-but-plausible fade still projects)', () => {
  assert.equal(fadeExceedsPlausibleCeiling(10), false);
});

test('fadeExceedsPlausibleCeiling — FALSE for a genuine healthy LFP fade (2.5 %/yr)', () => {
  assert.equal(fadeExceedsPlausibleCeiling(2.5), false);
});

test('fadeExceedsPlausibleCeiling — FALSE for a real ~7 %/yr abnormal-but-physical fade', () => {
  // An abnormal but physically-possible fade still projects a dated EOL — the guard
  // only rejects the >10 %/yr OLS artifact, it does not mask a genuine fast failure
  // (which the absolute-SoH threshold alarm catches independently anyway).
  assert.equal(fadeExceedsPlausibleCeiling(7), false);
});

test('fadeExceedsPlausibleCeiling — FALSE for null (no fit), flat, and improving packs', () => {
  assert.equal(fadeExceedsPlausibleCeiling(null), false);
  assert.equal(fadeExceedsPlausibleCeiling(0), false);
  assert.equal(fadeExceedsPlausibleCeiling(-1.2), false); // SoH improving (recalibration up)
});
