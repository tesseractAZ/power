import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURTAIL_TAPER_BAND_PCT, DEFAULT_CHARGE_CEILING_PCT, MORNING_SURPLUS_HOURS,
  saturationThresholdPct, meanChargeCeilingPct, surplusSpanEndMs, pvSurplusFromBand, taperCeilingKwh,
} from '../src/chargeTaper.js';

/**
 * R2 — chargeTaper.ts: where the packs stop taking solar (the taper band below the Cores' charge
 * ceiling, moved here from analytics.ts) and how much solar a charge must leave room for (the
 * surplus over a span, moved here from index.ts; the span itself, which differs for a mid-day
 * window; and the taper ceiling the mid-day cost ceiling is measured from).
 */

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 15, 22); // 15:00 MST

test('the constants', () => {
  assert.equal(CURTAIL_TAPER_BAND_PCT, 10);
  assert.equal(DEFAULT_CHARGE_CEILING_PCT, 100);
  assert.equal(MORNING_SURPLUS_HOURS, 14);
});

test('★★★ saturationThresholdPct: ceiling − 10; no ceiling reported ⇒ 100 − 10', () => {
  assert.equal(saturationThresholdPct(100), 90);
  assert.equal(saturationThresholdPct(80), 70);
  assert.equal(saturationThresholdPct(null), 90);
  assert.equal(saturationThresholdPct(0), 90, 'a non-positive ceiling is not a report');
  assert.equal(saturationThresholdPct(-5), 90);
  assert.equal(saturationThresholdPct(5), 0, 'never negative');
});

test('★★ meanChargeCeilingPct: the mean of the Cores that report one', () => {
  assert.equal(meanChargeCeilingPct([100, 80, null, undefined, 0, -1]), 90);
  assert.equal(meanChargeCeilingPct([100]), 100);
  assert.equal(meanChargeCeilingPct([]), null);
  assert.equal(meanChargeCeilingPct([null, 0]), null);
});

test('★★ one definition: analytics.ts reads the taper band from chargeTaper.ts', () => {
  const an = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/analytics.ts'), 'utf8');
  assert.ok(!/const CURTAIL_TAPER_BAND_PCT\s*=/.test(an), 'no second taper band');
  assert.ok(!/function saturationThresholdPct\(/.test(an), 'no second threshold');
  assert.ok(an.includes("import { saturationThresholdPct, meanChargeCeilingPct } from './chargeTaper.js';"));
  assert.ok(an.includes('return meanChargeCeilingPct(homeDpus.map((d) => d.projection.chgMaxSoc));'));
});

test('★★★ surplusSpanEndMs: an overnight window looks 14 h past its close; a mid-day window to the on-peak start', () => {
  assert.equal(surplusSpanEndMs('overnight', T0, null), T0 + 14 * H);
  assert.equal(surplusSpanEndMs('overnight', T0, T0 + H), T0 + 14 * H, 'the on-peak start does not bound an overnight span');
  assert.equal(surplusSpanEndMs('super_off_peak', T0, T0 + H), T0 + H);
  assert.equal(surplusSpanEndMs('super_off_peak', T0, null), T0 + 14 * H, 'no on-peak known: the overnight span');
  assert.equal(surplusSpanEndMs('super_off_peak', T0, T0 - H), T0 + 14 * H, 'an on-peak start before the close is not this window\'s');
  assert.equal(surplusSpanEndMs('super_off_peak', T0, T0), T0, 'a window that closes into on-peak leaves no span');
});

test('★★★ pvSurplusFromBand: Σ max(0, PV − load) over the covered hours of the span, P90 and P50', () => {
  const hours = [
    { ts: T0 - H, p90W: 9000, p50W: 8000 },   // before the span
    { ts: T0, p90W: 5000, p50W: 4000 },
    { ts: T0 + H, p90W: 2500, p50W: 1500 },   // P50 under the load: 0
    { ts: T0 + 2 * H, p90W: 6000, p50W: 5000 }, // no load: not covered
    { ts: T0 + 3 * H, p90W: 7000, p50W: 6000 }, // at the span end: excluded
  ];
  const loads = new Map([[T0 - H, 1000], [T0, 2000], [T0 + H, 2000], [T0 + 3 * H, 1000]]);
  const r = pvSurplusFromBand({ hours, loadAt: (ts) => loads.get(ts), fromMs: T0, toMs: T0 + 3 * H });
  assert.deepEqual(r, { p90Kwh: 3.5, p50Kwh: 2 });
  // No covered hour: both null — absence of a forecast is not a surplus of zero.
  assert.deepEqual(pvSurplusFromBand({ hours, loadAt: () => undefined, fromMs: T0, toMs: T0 + 3 * H }), { p90Kwh: null, p50Kwh: null });
  assert.deepEqual(pvSurplusFromBand({ hours: [], loadAt: () => 1000, fromMs: T0, toMs: T0 + 3 * H }), { p90Kwh: null, p50Kwh: null });
  // A covered hour with no median: the P50 is unknown, the P90 stands.
  const noMedian = hours.map((h) => (h.ts === T0 + H ? { ts: h.ts, p90W: h.p90W } : h));
  assert.deepEqual(pvSurplusFromBand({ hours: noMedian, loadAt: (ts) => loads.get(ts), fromMs: T0, toMs: T0 + 3 * H }), { p90Kwh: 3.5, p50Kwh: null });
  const nanMedian = hours.map((h) => (h.ts === T0 ? { ...h, p50W: Number.NaN } : h));
  assert.equal(pvSurplusFromBand({ hours: nanMedian, loadAt: (ts) => loads.get(ts), fromMs: T0, toMs: T0 + 3 * H }).p50Kwh, null);
  // Rounded to 0.01 kWh.
  assert.deepEqual(pvSurplusFromBand({ hours: [{ ts: T0, p90W: 1234.5, p50W: 1001.4 }], loadAt: () => 0, fromMs: T0, toMs: T0 + H }), { p90Kwh: 1.23, p50Kwh: 1 });
});

test('★★★ taperCeilingKwh: the taper line less the surplus still to come, never below 0', () => {
  assert.equal(taperCeilingKwh(100, 90, 5), 85);
  assert.equal(taperCeilingKwh(100, 90, null), 90, 'no surplus known: the taper line');
  assert.equal(taperCeilingKwh(100, 90, -3), 90, 'a negative surplus is none');
  assert.equal(taperCeilingKwh(100, 90, 120), 0);
  assert.equal(taperCeilingKwh(100, 130, 0), 100, 'the line is a share of the pool');
  assert.equal(taperCeilingKwh(92.16, 70, 0.5), 92.16 * 0.7 - 0.5);
});
