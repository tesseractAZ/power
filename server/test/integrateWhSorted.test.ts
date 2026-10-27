/**
 * v1.191.3 — windowIntegrator(points)(since, until) is integrateWh(points, since, until), for every input.
 *
 * computeTariffReport prices a week hour by hour: 168 windows per tally over each 7-day series, and
 * integrateWh filtered the whole series twice for each. windowIntegrator hands each window only the
 * points integrateWh reads (the last sample before `since` and every sample in [since, until]), found by
 * binary search on a series sorted by ts, and integrates any other series whole. This is an identity test
 * by design: random sorted series and windows, the boundary cases the slice could get wrong, and the
 * inputs that must take the whole-series path. scripts/mutate-v1191-3.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateWh, windowIntegrator } from '../src/aggregator.js';

type Pt = { ts: number; value: number };
const MIN = 60_000;

/** A seeded PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const same = (points: Pt[], s: number, u: number, what: string) =>
  assert.deepEqual(windowIntegrator(points)(s, u), integrateWh(points, s, u), `${what} [${s}, ${u}]`);

test('★★★ random sorted series and windows: identical to integrateWh on the whole series', () => {
  const rnd = prng(0x1913);
  for (let k = 0; k < 300; k++) {
    // Steps of 0 (equal timestamps) to 25 min (beyond the 10-min gap rule), some on the minute.
    const points: Pt[] = [];
    let ts = 1_792_000_000_000 + Math.floor(rnd() * 3_600_000);
    const n = Math.floor(rnd() * 400);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      ts += r < 0.05 ? 0 : r < 0.1 ? 25 * MIN : r < 0.6 ? MIN : Math.floor(rnd() * 12 * MIN);
      points.push({ ts, value: Math.round(rnd() * 5_000) });
    }
    const first = points[0]?.ts ?? 1_792_000_000_000;
    const last = points[points.length - 1]?.ts ?? first;
    const integ = windowIntegrator(points);
    for (let w = 0; w < 40; w++) {
      // Windows from before the first point to after the last, on samples and between them.
      const pick = () => (rnd() < 0.3 && points.length > 0 ? points[Math.floor(rnd() * points.length)].ts : first - 3_600_000 + Math.floor(rnd() * (last - first + 7_200_000)));
      const s = pick();
      const u = rnd() < 0.1 ? s - Math.floor(rnd() * MIN) : s + Math.floor(rnd() * 3 * 3_600_000);
      assert.deepEqual(integ(s, u), integrateWh(points, s, u), `series ${k}, window [${s}, ${u}]`);
    }
  }
});

test('★★★ the slice boundaries: the sample before the window, a sample exactly at either end, equal timestamps', () => {
  const pts: Pt[] = [
    { ts: 0, value: 100 }, { ts: MIN, value: 900 }, { ts: 2 * MIN, value: 300 }, { ts: 2 * MIN, value: 700 },
    { ts: 3 * MIN, value: 5_000 }, { ts: 4 * MIN, value: 200 }, { ts: 5 * MIN, value: 200 }, { ts: 5 * MIN, value: 4_000 },
  ];
  same(pts, 30_000, 150_000, 'the head comes from the sample before the window');
  same(pts, MIN, 3 * MIN, 'samples exactly at both ends');
  same(pts, 2 * MIN, 5 * MIN, 'equal timestamps at both ends');
  same(pts, 150_000, 3 * MIN, 'a sample exactly at the end, different from the one before it');
  // The samples a window reads differ from its neighbours': the integral moves with each boundary rule.
  assert.notDeepEqual(integrateWh(pts, MIN, 3 * MIN), integrateWh(pts.slice(1, 4), MIN, 3 * MIN), 'the control: the sample at the end counts');
  assert.notDeepEqual(integrateWh(pts, 30_000, 150_000), integrateWh(pts.slice(1, 4), 30_000, 150_000), 'the control: the sample before counts');
});

test('★★ windows outside the series, an empty or a one-point series, an inverted window, a gap over the start', () => {
  const pts: Pt[] = [{ ts: 10 * MIN, value: 1_000 }, { ts: 11 * MIN, value: 1_200 }, { ts: 30 * MIN, value: 1_400 }, { ts: 31 * MIN, value: 1_100 }];
  same(pts, 0, 5 * MIN, 'a window before every point');
  same(pts, 40 * MIN, 50 * MIN, 'a window after every point');
  same(pts, 35 * MIN, 32 * MIN, 'an inverted window');
  same(pts, 20 * MIN, 31 * MIN, 'a gap longer than 10 min straddling the start');
  same(pts, 11 * MIN, 30 * MIN, 'a gap longer than 10 min inside the window');
  same([], 0, MIN, 'an empty series');
  same([{ ts: 5 * MIN, value: 800 }], 0, 10 * MIN, 'one point inside');
  same([{ ts: 5 * MIN, value: 800 }], 6 * MIN, 10 * MIN, 'one point before');
});

test('★★★ a series out of order, or with a NaN timestamp, is integrated whole', () => {
  // Out of order: a sorted-run slice would leave out the in-window sample at 50 000.
  const unsorted: Pt[] = [{ ts: 0, value: 1_000 }, { ts: 100_000, value: 1_000 }, { ts: 50_000, value: 1_000 }, { ts: 150_000, value: 1_000 }];
  same(unsorted, 40_000, 60_000, 'out of order');
  assert.equal(windowIntegrator(unsorted)(40_000, 60_000).samples, 1);
  // A NaN between two out-of-order points: `points[i].ts < points[i - 1].ts` is false on both sides of
  // it, so only a check that sends every incomparable pair to the whole series sees the disorder.
  const withNaN: Pt[] = [{ ts: 0, value: 1_000 }, { ts: 100_000, value: 1_000 }, { ts: NaN, value: 5 }, { ts: 50_000, value: 1_000 }];
  same(withNaN, 40_000, 60_000, 'a NaN timestamp');
  assert.equal(windowIntegrator(withNaN)(40_000, 60_000).samples, 1);
  assert.ok(windowIntegrator(withNaN)(40_000, 60_000).wh > 5, 'the in-window sample is integrated');
});
