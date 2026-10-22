import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadeHoursFromCorePvMaps } from '../src/analytics.js';
import type { WeatherHour } from '../src/weather.js';
import { addDaysYmd, siteTimeZone, zonedWallTimeMs } from '../src/siteTime.js';

/*
 * v0.93.0 (audit #9) — shadeHoursFromCorePvMaps must derive the shade shortfall
 * PER-CORE (mirroring fleetSoilingFromDevices), so a single Core's cloud-gap zero
 * hour drops out of its OWN p90 reference and can NOT deflate anyone else's — the
 * summed-fleet path it replaced counted that hour ~1/N short (still positive) and
 * read a phantom 58-91% shortfall while every array was really fine.
 *
 * The tests are deterministic: hour-epochs and clear-sky weather are injected. The helper
 * buckets by the UTC hour (the hour-epoch) and labels each bucket with the site hour and site
 * date of its START (siteHour / siteYmd of he × 1 h). The fixture takes, for each site day and
 * each of three site hours h, the first UTC hour that starts at or after site h:00. That
 * bucket starts inside site hour h in every zone: on a whole-hour offset it starts at h:00, on
 * a :30 or :45 offset at h:30 or h:45, so each hour-of-day group holds one epoch per site day,
 * across a daylight-saving change too (the 8 days from 2025-04-01 cross the end of DST in
 * Auckland, Sydney, Santiago and Lord Howe Island on 04-06; Lord Howe's clock moves by half an
 * hour, so a site hour's bucket starts at h:00 before the change and at h:30 after it). Fixed
 * UTC epochs moved to the neighbouring site hour at the change, splitting each hour's days
 * between two groups, so the shade the two shade cases put on the recent days went unreported.
 * The UTC hour that merely CONTAINS site h:00 starts at (h-1):30 on a :30 offset, which the
 * report labels h-1: every group an hour early on a fixed :30 zone (Kolkata), and on Lord Howe
 * Island only the days after the change, the same split.
 */

const HR = 3_600_000;
const CLEAR: Omit<WeatherHour, 'ts'> = { cloudCoverPct: 5, radiationWm2: 800, tempC: 25 };

// Build a clear-sky weather map + N days × 3 clear hours-of-day of hour-epochs.
// Returns { wx, epochs, dayOf } where epochs are grouped so every hour-of-day used has
// >= days distinct days (satisfies SHADE_MIN_CLEAR_DAYS=5 and the >=3-hour refCoeff),
// and dayOf maps each epoch to its day index.
function clearSkyGrid(days: number): { wx: Map<number, WeatherHour>; epochs: number[]; dayOf: Map<number, number> } {
  const wx = new Map<number, WeatherHour>();
  const epochs: number[] = [];
  const dayOf = new Map<number, number>();
  for (let d = 0; d < days; d++) {
    for (const hour of [11, 13, 15]) { // 3 distinct clear site hours per day
      // The first UTC hour-epoch that starts at or after this site wall time: the code labels
      // it with this site hour in every zone (floor would take the epoch that starts at
      // (hour-1):30 on a :30 offset, which the code labels hour-1).
      const he = Math.ceil(zonedWallTimeMs(addDaysYmd('2025-04-01', d), hour, 0, siteTimeZone()) / HR);
      wx.set(he, { ts: he * HR, ...CLEAR });
      epochs.push(he);
      dayOf.set(he, d);
    }
  }
  return { wx, epochs, dayOf };
}

test('shadeHoursFromCorePvMaps — two clean Cores → no shade, zero kWh', () => {
  const { wx, epochs } = clearSkyGrid(8);
  // Both Cores produce the same coeff (2 W per W/m²) on every clear hour → no shade.
  const coreA = new Map<number, number>(epochs.map((he) => [he, 2 * CLEAR.radiationWm2]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, 2 * CLEAR.radiationWm2]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.equal(out.hours.length, 0);
  assert.equal(out.estTotalKwhPerYear, 0);
});

test('shadeHoursFromCorePvMaps — one Core cloud-gap zeros do NOT create phantom shade', () => {
  const { wx, epochs, dayOf } = clearSkyGrid(8);
  const full = 2 * CLEAR.radiationWm2;
  const coreA = new Map<number, number>(epochs.map((he) => [he, full]));
  // Core B is a wedged Core: it reports 0 W on every clear hour of some days (a cloud/telemetry
  // gap), full production otherwise. Per-Core, B's zero hours fail coeff>0 and drop out of B's
  // own p90 reference; A shows none.
  //  - Gap on the two oldest days: two zero days of eight do not move B's median observed.
  //    (This shape alone also passes the summed-fleet path.)
  //  - Gap on the six most recent days: B keeps two clear hours a group, too few for its own
  //    reference, and adds nothing. The pre-v0.93.0 summed fleet read 3200 W on the two old
  //    days and 1600 W since: its p90 reference 3200 W against a median 1600 W, a phantom 50 %
  //    shortfall on every clear hour and about 1750 kWh a year.
  for (const [gap, dark] of [
    ['the two oldest days', (d: number) => d < 2],
    ['the six most recent days', (d: number) => d >= 2],
  ] as const) {
    const coreB = new Map<number, number>(epochs.map((he) => [he, dark(dayOf.get(he)!) ? 0 : full]));
    const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
    assert.deepEqual(out.hours, [], `no phantom shaded hour from a Core gap on ${gap}`);
    assert.equal(out.estTotalKwhPerYear, 0, `no phantom annual kWh shortfall (gap on ${gap})`);
  }
});

test('shadeHoursFromCorePvMaps — real uniform shade IS still detected', () => {
  const { wx, epochs, dayOf } = clearSkyGrid(8);
  // Both Cores really under-produce 40% vs their own clean p90 on the most recent days.
  // Model: first 4 days clean (coeff 2.0), last 4 days shaded (coeff 1.2) on EVERY hour →
  // per-Core p90 2.0; the median observed over the 8 days is midway (1280 W against an
  // expected 1600 W) → a 20% shortfall, above the 18% threshold, on BOTH Cores.
  const coeffFor = (he: number): number => (dayOf.get(he)! >= 4 ? 1.2 : 2.0);
  const coreA = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.ok(out.hours.length > 0, 'genuine uniform under-production is reported');
  for (const h of out.hours) {
    assert.ok(h.shortfallPct >= 18, `shortfall ${h.shortfallPct}% >= threshold`);
    // expectedW/observedW are fleet-scale SUMS across the 2 contributing Cores.
    assert.ok(h.expectedW > h.observedW);
  }
  assert.ok(out.estTotalKwhPerYear > 0, 'real shade yields a positive kWh/yr estimate');
});

test('shadeHoursFromCorePvMaps — one Core of three dark on most recent days: no phantom shade (the summed fleet reads 33 %)', () => {
  const { wx, epochs, dayOf } = clearSkyGrid(8);
  const full = 2 * CLEAR.radiationWm2;
  // Core B reports 0 W on the 6 most recent days (dark), A and C produce fully throughout.
  // Per-Core: B keeps two clear hours a group, too few for its own reference, so B adds
  // nothing; A and C show no shortfall. The pre-v0.93.0 summed fleet read 4800 W on the
  // two old days and 3200 W since: its p90 reference 4800 W against a median 3200 W, a
  // phantom 33 % shortfall on every clear hour and about 1750 kWh a year.
  const coreA = new Map<number, number>(epochs.map((he) => [he, full]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, dayOf.get(he)! >= 2 ? 0 : full]));
  const coreC = new Map<number, number>(epochs.map((he) => [he, full]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB, coreC], wx);
  assert.deepEqual(out.hours, [], 'a dark Core is not shade');
  assert.equal(out.estTotalKwhPerYear, 0, 'no phantom annual kWh shortfall');
});

test('shadeHoursFromCorePvMaps — shade on most recent days is measured against the clean days\' p90, not their median', () => {
  const { wx, epochs, dayOf } = clearSkyGrid(8);
  // Both Cores shaded (coeff 1.2) on the 5 most recent days, clean (2.0) on the 3 before.
  // The p90 reference is the clean 2.0 (1600 W expected); the median observed is 960 W →
  // 40 % on every clear hour. A median reference would be the shaded 1.2 and find none.
  const coeffFor = (he: number): number => (dayOf.get(he)! >= 3 ? 1.2 : 2.0);
  const coreA = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const coreB = new Map<number, number>(epochs.map((he) => [he, coeffFor(he) * CLEAR.radiationWm2]));
  const out = shadeHoursFromCorePvMaps([coreA, coreB], wx);
  assert.deepEqual(out.hours.map((h) => [h.hour, h.shortfallPct, h.expectedW, h.observedW, h.clearDays]), [
    [11, 40, 3200, 1920, 8], [13, 40, 3200, 1920, 8], [15, 40, 3200, 1920, 8],
  ], 'the three clear site hours, each 40 % short of the clean reference');
  // (1600 − 960) W × 365 days = 233.6 kWh a year per Core and hour; × 3 hours × 2 Cores.
  assert.equal(out.estTotalKwhPerYear, 1402);
});

test('shadeHoursFromCorePvMaps — empty input → no hours, zero kWh', () => {
  const out = shadeHoursFromCorePvMaps([], new Map());
  assert.equal(out.hours.length, 0);
  assert.equal(out.estTotalKwhPerYear, 0);
});
