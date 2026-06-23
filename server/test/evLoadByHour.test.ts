import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evLoadByHour } from '../src/analytics.js';

/* v0.55.0 — the home has ONE EVSE, so overlapping predicted EV-charging sessions are
 * alternatives (which recurring window will fire), not two cars at once. The forecast must
 * take the MAX watts per covered hour, not the SUM — the old SUM stacked long overlapping
 * windows into a physically-impossible ~17 kW (one Tesla session is ≤11.5 kW), projecting the
 * overnight pool to 0% and inflating the forecast-soc-dip warning. */

const H = 3_600_000;

test('evLoadByHour — overlapping sessions take MAX per hour, never SUM (single charger)', () => {
  const sessions = [
    { ts: 0, durationHours: 3, watts: 7000 }, // covers hours 0,1,2
    { ts: H, durationHours: 2, watts: 6000 }, // covers hours 1,2
  ];
  const m = evLoadByHour(sessions, 11520);
  assert.equal(m.get(0), 7000, 'hour 0: only session A');
  assert.equal(m.get(1), 7000, 'hour 1: MAX(7000,6000) — NOT 13000');
  assert.equal(m.get(2), 7000, 'hour 2: MAX(7000,6000)');
  assert.equal(m.get(3), undefined, 'no session covers hour 3');
});

test('evLoadByHour — the incident shape: stacked sessions no longer reach 17 kW', () => {
  // Three overlapping windows that the old SUM would have stacked to 17+ kW at hour 0.
  const sessions = [
    { ts: 0, durationHours: 4, watts: 7000 },
    { ts: 0, durationHours: 2, watts: 6000 },
    { ts: 0, durationHours: 1, watts: 4000 },
  ];
  const m = evLoadByHour(sessions, 11520);
  assert.equal(m.get(0), 7000, 'one charger → the largest single session, not 17000');
});

test('evLoadByHour — a single anomalous session is hard-capped at the charger max', () => {
  const m = evLoadByHour([{ ts: 0, durationHours: 1, watts: 17025 }], 11520);
  assert.equal(m.get(0), 11520, 'a single 17 kW recorded session is physically impossible → capped');
});

test('evLoadByHour — a real in-bounds session passes through unchanged', () => {
  const m = evLoadByHour([{ ts: 0, durationHours: 2, watts: 7680 }], 11520);
  assert.equal(m.get(0), 7680);
  assert.equal(m.get(1), 7680);
});

test('evLoadByHour — empty sessions → empty map', () => {
  assert.equal(evLoadByHour([], 11520).size, 0);
});

/* v0.56.0 — recurrence-probability weighting (expected-value load). A charger seen on only a
 * few of the observed days should contribute a FRACTION of its watts, so a sometimes-charger
 * stops hard-projecting an overnight 0% (the live circuit-5 case: 10 kW seen 3 of ~28 days). */

test('evLoadByHour — a low-recurrence session contributes its EXPECTED watts, not full', () => {
  // The live incident shape: ~10 kW, 2.1h, fired 3 of ~28 days → P≈0.107 → ~1.08 kW expected.
  const m = evLoadByHour([{ ts: 0, durationHours: 2.1, watts: 10055, probability: 3 / 28 }], 11520);
  assert.ok(m.get(0)! < 1500 && m.get(0)! > 900, `expected ~1.08kW, got ${m.get(0)}`);
});

test('evLoadByHour — omitted probability ⇒ P=1 (backward compatible)', () => {
  const m = evLoadByHour([{ ts: 0, durationHours: 1, watts: 7680 }], 11520);
  assert.equal(m.get(0), 7680);
});

test('evLoadByHour — P=1 every-day charger passes full (capped) watts', () => {
  const m = evLoadByHour([{ ts: 0, durationHours: 1, watts: 7680, probability: 1 }], 11520);
  assert.equal(m.get(0), 7680);
});

test('evLoadByHour — cap applies to the REAL session first, THEN the weight', () => {
  // min(17025, 11520) × 0.5 = 5760  (NOT 17025×0.5=8512.5, NOT capped-after).
  const m = evLoadByHour([{ ts: 0, durationHours: 1, watts: 17025, probability: 0.5 }], 11520);
  assert.equal(m.get(0), 5760);
});

test('evLoadByHour — overlap takes MAX of EXPECTED values (high-watt low-P no longer dominates)', () => {
  // A:7000×0.2=1400 vs B:3500×1.0=3500 covering the same hour → 3500 (the more likely session wins).
  const m = evLoadByHour([
    { ts: 0, durationHours: 1, watts: 7000, probability: 0.2 },
    { ts: 0, durationHours: 1, watts: 3500, probability: 1.0 },
  ], 11520);
  assert.equal(m.get(0), 3500);
});
