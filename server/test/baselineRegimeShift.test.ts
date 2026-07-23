import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regimeShiftDays, REGIME_SHIFT_MIN_DAYS } from '../src/analytics.js';

/* v1.42.0 — the regime-shift detector: trailing consecutive days of same-
 * direction deviation. A persistent behavior change (two AC zones swapping
 * duty) must read as a new-normal absorption, not endless anomaly churn —
 * while a fresh 1–2 day excursion keeps normal annunciation. */

const DAY = 86_400_000;
const NOW = 1_800_000 * 3_600_000;

/** N days of samples: `flippedDays` most-recent days at `newV`, rest at `oldV`. */
function series(totalDays: number, flippedDays: number, oldV: number, newV: number) {
  const pts: Array<{ ts: number; v: number }> = [];
  for (let d = 0; d < totalDays; d++) {
    for (const off of [0.2, 0.5, 0.8]) {
      pts.push({ ts: NOW - (d + off) * DAY, v: d < flippedDays ? newV : oldV });
    }
  }
  return pts;
}

test('regime — 6-day flip counts 6 trailing days (≥ threshold ⇒ silences)', () => {
  const pts = series(14, 6, 3400, 145); // East AC: high regime → idle regime
  const days = regimeShiftDays(pts, 3400, 300, Math.sign(145 - 3400), NOW);
  assert.equal(days, 6);
  assert.ok(days >= REGIME_SHIFT_MIN_DAYS);
});

test('regime — 2-day excursion stays below the threshold (normal annunciation)', () => {
  const pts = series(14, 2, 3400, 145);
  const days = regimeShiftDays(pts, 3400, 300, -1, NOW);
  assert.equal(days, 2);
  assert.ok(days < REGIME_SHIFT_MIN_DAYS);
});

test('regime — an opposite-direction day breaks the streak', () => {
  const pts = series(14, 6, 3400, 145);
  // day 3 back bounces ABOVE the median → streak ends at 3
  for (const p of pts) if (p.ts > NOW - 4 * DAY && p.ts <= NOW - 3 * DAY) p.v = 3900;
  assert.equal(regimeShiftDays(pts, 3400, 300, -1, NOW), 3);
});

test('regime — deviations under the floor do not count', () => {
  const pts = series(14, 6, 3400, 3300); // 100 W drift < 300 W floor
  assert.equal(regimeShiftDays(pts, 3400, 300, -1, NOW), 0);
});
