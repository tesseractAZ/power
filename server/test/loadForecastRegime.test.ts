/**
 * v1.9.0 — engine-review fixes F12 + F5 (the runway 4-8h audible tiers' load basis).
 *
 * F12 (blendNightLoad overshoot): the v0.59 trim's premise ("curve 2x
 * over-predicts nights") expired — the review measured the raw night curve
 * near-unbiased (-77W) while the trim was converting +957W of raw bias into a
 * -462W UNDER-prediction (mean trim 1419W), and the single generation-time 3h
 * anchor was being applied to the NEXT evening's hours (04:00 idle anchor
 * gutting 21:00-23:00 AC by 26-37%). Three gates under test:
 *   (a) blendNightLoad floors at the observed load (never trims below it),
 *   (b) isSameNightTrimWindow — anchor only trims hours of THIS ongoing night,
 *   (c) shouldTrimNightCurve — empirical premise check disables the trim when
 *       the curve is already unbiased.
 *
 * F5 (summer regime lag): the plain 30d trailing mean lagged the June→July
 * load ramp by ~13-17% at daytime hours. weightedHourCurveByWeekday
 * exponentially down-weights old samples (half-life days) so the curve tracks
 * the current regime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blendNightLoad,
  isSameNightTrimWindow,
  shouldTrimNightCurve,
  weightedHourCurveByWeekday,
} from '../src/analytics.js';

const DAY = 86_400_000;

/* ── F12(a): floor at observed load ────────────────────────────────────── */

test('blendNightLoad — default-param behaviour unchanged (trims toward recent, floor-capped)', () => {
  assert.equal(blendNightLoad(6000, 3200, 1.5, 0.6, 0.5), 6000 * 0.4 + 3200 * 0.6);
  assert.equal(blendNightLoad(3000, 3200, 1.5, 0.6, 0.5), 3000, 'never raises');
});

test('blendNightLoad — can never land BELOW the observed load, regardless of params', () => {
  // blend > 1 (a mis-set env) used to extrapolate PAST recent: 3000*(-0.2)+1000*1.2 = 600.
  // The v1.9.0 floor pins it at the observed 1000 W.
  assert.equal(blendNightLoad(3000, 1000, 1.5, 1.2, 1.0), 1000);
  // maxTrim=1 with blend=1 → exactly the observed load, not below.
  assert.equal(blendNightLoad(3000, 1000, 1.5, 1.0, 1.0), 1000);
});

/* ── F12(b): same-night gating ─────────────────────────────────────────── */

test('isSameNightTrimWindow — early-morning anchor may NOT trim the next evening', () => {
  // Generation at 04:00; next evening 21:00 is 17 h ahead — a DIFFERENT night.
  assert.equal(isSameNightTrimWindow(4, 21, 17), false);
});

test('isSameNightTrimWindow — an in-night anchor trims the rest of THIS night', () => {
  assert.equal(isSameNightTrimWindow(22, 2, 4), true);   // 22:00 → 02:00
  assert.equal(isSameNightTrimWindow(23, 5, 6), true);   // 23:00 → 05:00
  assert.equal(isSameNightTrimWindow(21, 5, 8), true);   // full band, 21:00 → 05:00
});

test('isSameNightTrimWindow — a daytime anchor never trims (it does not measure night load)', () => {
  assert.equal(isSameNightTrimWindow(14, 22, 8), false); // 14:00 anchor is AC load, not idle floor
  assert.equal(isSameNightTrimWindow(9, 21, 12), false);
});

test('isSameNightTrimWindow — daytime targets are never trimmed even from a night anchor', () => {
  assert.equal(isSameNightTrimWindow(22, 14, 16), false);
  assert.equal(isSameNightTrimWindow(4, 12, 8), false);
});

/* ── F12(c): empirical premise check ───────────────────────────────────── */

const pairs = (n: number, predictedW: number, actualW: number) =>
  Array.from({ length: n }, () => ({ predictedW, actualW }));

test('shouldTrimNightCurve — ENABLED when the curve materially over-predicts nights (the v0.59 regime)', () => {
  assert.equal(shouldTrimNightCurve(pairs(40, 2000, 900)), true); // ~2.2x over
});

test('shouldTrimNightCurve — DISABLED when the curve is near-unbiased (the measured current regime)', () => {
  // The review's live shape: raw night bias ≈ -77 W on ~1-2 kW nights.
  assert.equal(shouldTrimNightCurve(pairs(40, 1500, 1577)), false);
  assert.equal(shouldTrimNightCurve(pairs(40, 1600, 1550)), false, '+50W is inside the noise floor');
});

test('shouldTrimNightCurve — DISABLED when the curve UNDER-predicts (trimming would double the error)', () => {
  assert.equal(shouldTrimNightCurve(pairs(40, 900, 1400)), false);
});

test('shouldTrimNightCurve — both the fractional AND absolute bias floors must be exceeded', () => {
  // +200 W on an 8 kW night is 2.5% — material in watts? No: frac gate (25% of 8kW = 2kW) blocks it.
  assert.equal(shouldTrimNightCurve(pairs(40, 8200, 8000)), false);
  // +140 W on a 100 W night is 140% fractionally — but under the 150 W absolute floor.
  assert.equal(shouldTrimNightCurve(pairs(40, 240, 100)), false, '140W bias is under the 150W absolute floor');
  assert.equal(shouldTrimNightCurve(pairs(40, 300, 100)), true, '200W bias over a 100W night clears both floors');
});

test('shouldTrimNightCurve — too little hindcast history keeps the trim (cold-curve = original stale-curve regime)', () => {
  assert.equal(shouldTrimNightCurve(pairs(5, 1500, 1500)), true);
  assert.equal(shouldTrimNightCurve([]), true);
});

/* ── F5: recency-weighted load curve ───────────────────────────────────── */

/** Build one sample per day at the same clock hour, `watts(dayAge)` each. */
function dailySamples(nowMs: number, days: number, watts: (ageDays: number) => number) {
  const out: Array<{ ts: number; value: number }> = [];
  for (let a = 0; a < days; a++) out.push({ ts: nowMs - a * DAY, value: watts(a) });
  return out;
}

test('weightedHourCurveByWeekday — tracks a regime shift instead of lagging it by half the window', () => {
  // June→July ramp shape: last 7 days at 5 kW, the 23 before at 2 kW.
  const now = Date.UTC(2026, 6, 11, 12, 0, 0); // fixed for determinism
  const pts = dailySamples(now, 30, (a) => (a < 7 ? 5000 : 2000));
  const h = new Date(now).getHours();
  const plain = weightedHourCurveByWeekday(pts, now, 0); // half-life 0 → plain mean
  const weighted = weightedHourCurveByWeekday(pts, now, 7);
  assert.ok(Math.abs(plain.combined[h] - 2700) < 1, 'plain mean sits at the 30d blend (2.7 kW)');
  // With a 7-day half-life the curve is ~72% converged to the new regime after
  // one week of it (≈3.58 kW here vs the plain mean's 54%) — tracks the ramp
  // without snapping to raw last-samples.
  assert.ok(weighted.combined[h] > 3400, `recency-weighted follows the new 5 kW regime (got ${weighted.combined[h].toFixed(0)})`);
  assert.ok(weighted.combined[h] < 5000, 'still smoothed — not a raw last-sample snap');
});

test('weightedHourCurveByWeekday — half-life <= 0 (or non-finite) degrades to the plain mean', () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  const pts = dailySamples(now, 10, (a) => 1000 + a * 100);
  const h = new Date(now).getHours();
  const plain = weightedHourCurveByWeekday(pts, now, 0);
  const nan = weightedHourCurveByWeekday(pts, now, NaN);
  const expected = pts.reduce((s, p) => s + p.value, 0) / pts.length;
  assert.ok(Math.abs(plain.combined[h] - expected) < 1e-9);
  assert.ok(Math.abs(nan.combined[h] - expected) < 1e-9);
});

test('weightedHourCurveByWeekday — weekday/weekend split + thin-bucket fallback preserved', () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0); // Sat Jul 11 2026 (UTC)
  // Interleave weekday 3 kW and weekend 1 kW samples at the same clock hour.
  const pts: Array<{ ts: number; value: number }> = [];
  for (let a = 0; a < 14; a++) {
    const ts = now - a * DAY;
    const dow = new Date(ts).getDay();
    pts.push({ ts, value: dow === 0 || dow === 6 ? 1000 : 3000 });
  }
  const r = weightedHourCurveByWeekday(pts, now, 7);
  const h = new Date(now).getHours();
  assert.ok(r.weekday[h] > 2900, 'weekday bucket ≈ 3 kW');
  assert.ok(r.weekend[h] < 1100, 'weekend bucket ≈ 1 kW');
  assert.equal(r.weekdaySamples + r.weekendSamples, 14);
  // An hour with NO samples falls back to the combined value of that hour (NaN
  // here since combined is also empty) — but a weekday-empty/weekend-present
  // hour must use combined:
  const oneWknd = [{ ts: now, value: 1200 }]; // Saturday only
  const r2 = weightedHourCurveByWeekday(oneWknd, now, 7);
  assert.equal(r2.weekday[h], r2.combined[h], 'empty weekday bucket falls back to combined');
});
