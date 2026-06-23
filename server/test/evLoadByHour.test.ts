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
