import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSolarResponse, computeConfidenceSnapshot } from '../src/analytics.js';
import type { ForecastSkillReport, FleetDegradation, AmbientThermalReport } from '../src/analytics.js';

/* ===================================================================
 * v1.20.0 — engine-review F21: solar-model metrics that mean something.
 *
 * Within-slot Pearson r² tracks the WEATHER REGIME, not the model: under
 * clear-sky stretches per-slot GHI is near-constant day-to-day and slot
 * r² degenerates to ~0.00-0.15 for a model whose day-level replay scores
 * r²≈0.94 (monsoon variability intermittently revives it). Two
 * consequences fixed here:
 *  1. the peakCoeff r²≥0.2 gate starved the fleet "Peak response"
 *     headline to a confident 0.0 W per W/m² in clear-sky regimes
 *     (observed ~8-11) and let it flap back with the sky → gate replaced
 *     with slot BRIGHTNESS + samples (what actually conditions a
 *     through-origin slope);
 *  2. the confidence tile headlined the degenerate median (0.02, "the
 *     model explains 2% of variance") → replaced with the day-level
 *     replay r² of predicted vs actual daily kWh from the skill report.
 * =================================================================== */

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;

/** Build (pv, ghi) epoch maps: `days` days, each day one sample per listed
 *  hour-of-day, values from the per-hour generator. Epochs are hour counts. */
function series(
  days: number,
  hours: Array<{ hod: number; ghi: (day: number) => number; pv: (day: number, ghi: number) => number }>,
) {
  const pvByEpoch = new Map<number, number>();
  const ghiByEpoch = new Map<number, number>();
  // Anchor to a UTC-midnight-aligned epoch so hour-of-day mapping is exact
  // under the local timezone used by buildSolarResponse (new Date().getHours()).
  const baseEpoch = Math.floor(1_790_000_000_000 / HOUR_MS / DAY_HOURS) * DAY_HOURS;
  for (let d = 0; d < days; d++) {
    for (const h of hours) {
      // Find the epoch within this day whose LOCAL hour equals h.hod.
      for (let e = 0; e < DAY_HOURS; e++) {
        const epoch = baseEpoch + d * DAY_HOURS + e;
        if (new Date(epoch * HOUR_MS).getHours() !== h.hod) continue;
        const ghi = h.ghi(d);
        ghiByEpoch.set(epoch, ghi);
        pvByEpoch.set(epoch, h.pv(d, ghi));
        break;
      }
    }
  }
  return { pvByEpoch, ghiByEpoch };
}

test('F21 — a bright low-variance slot (r²≈0) sets the peak coefficient; the old r² gate starved it', () => {
  // Noon slot: GHI ~900±20 (CV ~2% — Phoenix summer), PV = 9·GHI + noise.
  // Within-slot r² is tiny by construction, but the slope is superbly
  // conditioned (through-origin over ~900 W/m²).
  const noise = [120, -80, 40, -150, 90, -30, 60, -110, 20, 70]; // deterministic
  const { pvByEpoch, ghiByEpoch } = series(10, [
    // Identical GHI every day (zero within-slot variance — the limit of the
    // Phoenix-summer regime) + PV noise: analytics defines slot r² = 0 here,
    // yet the through-origin slope over ~900 W/m² is superbly conditioned.
    { hod: 12, ghi: () => 900, pv: (d, g) => 9 * g + noise[d % noise.length] },
  ]);
  const m = buildSolarResponse(pvByEpoch, ghiByEpoch);
  const noon = m.hourly.find((h) => h.hour === 12)!;
  assert.ok(noon.r2 < 0.2, `fixture must reproduce the degenerate regime (r²=${noon.r2})`);
  assert.ok(noon.meanGhiWm2! >= 900, `slot brightness published (${noon.meanGhiWm2})`);
  assert.ok(
    m.peakCoeff > 8.5 && m.peakCoeff < 9.5,
    `peak must reflect the real ~9 W per W/m² response despite r²≈0; got ${m.peakCoeff}`,
  );
});

test('F21 — the dawn-instability case the old gate existed for is still excluded (brightness floor)', () => {
  // Dawn slot: GHI ~25 W/m² with a wild slope (the v0.41.0 bug: an unstable
  // low-GHI hour falsely winning "peak" and mislabeling array orientation).
  const { pvByEpoch, ghiByEpoch } = series(10, [
    { hod: 6, ghi: (d) => 25 + (d % 3), pv: (d, g) => 40 * g }, // absurd 40 W per W/m²
    { hod: 12, ghi: () => 900, pv: (_d, g) => 9 * g },
  ]);
  const m = buildSolarResponse(pvByEpoch, ghiByEpoch);
  const dawn = m.hourly.find((h) => h.hour === 6)!;
  assert.ok(dawn.coeff! > 30, 'the unstable dawn slope exists in the diagnostics');
  assert.ok(
    m.peakCoeff < 10,
    `the dawn slope must NOT win peak (brightness floor); got ${m.peakCoeff}`,
  );
});

test('F21 — a high-variance climate (real correlation) still produces the same peak (regression)', () => {
  // Variable-sky regime: GHI swings 300-900 within the slot, PV tracks it.
  const { pvByEpoch, ghiByEpoch } = series(10, [
    { hod: 12, ghi: (d) => 300 + d * 65, pv: (_d, g) => 9 * g },
  ]);
  const m = buildSolarResponse(pvByEpoch, ghiByEpoch);
  const noon = m.hourly.find((h) => h.hour === 12)!;
  assert.ok(noon.r2 > 0.9, `variable sky gives a real r² (${noon.r2})`);
  assert.ok(m.peakCoeff > 8.5 && m.peakCoeff < 9.5, `peak still ~9; got ${m.peakCoeff}`);
});

test('F21 — a bright slot with too few samples cannot set peak', () => {
  const { pvByEpoch, ghiByEpoch } = series(2, [
    { hod: 12, ghi: () => 900, pv: (_d, g) => 9 * g },
  ]);
  const m = buildSolarResponse(pvByEpoch, ghiByEpoch);
  assert.equal(m.peakCoeff, 0, '2 samples fit a slope but must not headline it');
});

test('F21 — the model publishes the brightness threshold the gate actually used (mirror contract)', () => {
  // The web ForecastDetail/SolarResponseCard mirrors gate on peakGateMinGhiWm2
  // from the payload instead of hardcoding 300 — pin that the field exists and
  // matches the default so a future env override can't silently diverge the UI.
  const { pvByEpoch, ghiByEpoch } = series(3, [{ hod: 12, ghi: () => 900, pv: (_d, g) => 9 * g }]);
  const m = buildSolarResponse(pvByEpoch, ghiByEpoch);
  assert.equal(m.peakGateMinGhiWm2, 300);
});

/* ── confidence: day-level replay r² ──────────────────────────────── */

function skillWith(days: ForecastSkillReport['days']): ForecastSkillReport {
  return { generatedAt: 0, days, meanAbsErrorKwh: 1, meanAbsErrorPct: 19.4, biasFactor: 1.0, windowDays: 7 };
}
function skillDay(predictedKwh: number, actualKwh: number, covered = true): ForecastSkillReport['days'][number] {
  return {
    date: '2026-07-01', predictedKwh, actualKwh,
    errorKwh: actualKwh - predictedKwh,
    errorPct: covered ? ((actualKwh - predictedKwh) / Math.max(1, predictedKwh)) * 100 : null,
    weatherCovered: covered,
  } as any;
}
/** The v1.10 telemetry-coverage-gap shape: weather WAS covered but the day's
 *  PV telemetry was gapped, so it publishes errorPct:null while
 *  weatherCovered:true — the row must fail the scored filter on the errorPct
 *  conjunct ALONE (review fix: skillDay couples both flags, leaving that
 *  conjunct unpinned). */
function coverageGapDay(predictedKwh: number, actualKwh: number): ForecastSkillReport['days'][number] {
  return {
    date: '2026-07-01', predictedKwh, actualKwh,
    errorKwh: null, errorPct: null,
    weatherCovered: true, coverageGap: true,
  } as any;
}
const emptyDeg = { packs: [] } as unknown as FleetDegradation;
const emptyTherm = { packs: [] } as unknown as AmbientThermalReport;

test('F21 — forecastDayR2 is the day-level replay r², not the degenerate within-slot median', () => {
  // Perfectly tracking days → r² = 1; a strong-but-imperfect set → high r².
  const days = [
    skillDay(50, 52), skillDay(60, 58), skillDay(40, 41),
    skillDay(70, 73), skillDay(55, 54), skillDay(65, 66),
  ];
  const c = computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(days));
  assert.ok(c.forecastDayR2 != null && c.forecastDayR2 > 0.9, `strong replay → high r²; got ${c.forecastDayR2}`);
  assert.ok(!('solarModelMedianR2' in c), 'the degenerate field is gone, not silently coexisting');
});

test('F21 — forecastDayR2 requires ≥5 scored days and skips coverage-excluded days', () => {
  const thin = [skillDay(50, 52), skillDay(60, 58), skillDay(40, 41), skillDay(70, 73)];
  assert.equal(
    computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(thin)).forecastDayR2,
    null,
    '4 days is not a skill estimate',
  );
  // 6 days but 2 are coverage-excluded (errorPct null / weather uncovered) → 4 scored → null.
  const mixed = [
    skillDay(50, 52), skillDay(60, 58), skillDay(40, 41), skillDay(70, 73),
    skillDay(55, 0, false), skillDay(65, 0, false),
  ];
  assert.equal(
    computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(mixed)).forecastDayR2,
    null,
    'coverage-excluded days must not count toward the floor',
  );
});

test('F21 — telemetry-gapped days (weatherCovered:true, errorPct:null) are excluded on the errorPct conjunct alone', () => {
  // Review fix: skillDay(…, false) flips BOTH filter conjuncts at once, so a
  // mutant that drops `d.errorPct != null` from the scored filter passed the
  // whole suite. These rows fail ONLY that conjunct — 4 scored + 2 gapped must
  // read null (a conjunct-dropping mutant sees 6 scored → non-null).
  const gapped = [
    skillDay(50, 52), skillDay(60, 58), skillDay(40, 41), skillDay(70, 73),
    coverageGapDay(55, 0), coverageGapDay(65, 0),
  ];
  assert.equal(computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(gapped)).forecastDayR2, null);
  // And with the floor already met, a wildly-off gapped row must not move the value.
  const base = [
    skillDay(50, 52), skillDay(60, 58), skillDay(40, 41),
    skillDay(70, 73), skillDay(55, 54), skillDay(65, 66),
  ];
  const clean = computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(base)).forecastDayR2;
  const polluted = computeConfidenceSnapshot(
    emptyDeg, emptyTherm, skillWith([...base, coverageGapDay(60, 0)]),
  ).forecastDayR2;
  assert.equal(polluted, clean, 'a gapped row must not perturb the scored r²');
});

test('F21 — forecastDayR2 is the SQUARED correlation: a perfectly anti-tracking replay reads 1, not −1', () => {
  // Kills the mutation survivor that returned raw Pearson r: on this fixture
  // r = −1 exactly, r² = 1. (Sign-blindness is the documented spec — the
  // through-origin PV model cannot produce negative day-level covariance in
  // practice; see the review's rejected sign-blind finding.)
  const anti = [
    skillDay(40, 70), skillDay(50, 60), skillDay(60, 50),
    skillDay(70, 40), skillDay(45, 65), skillDay(65, 45),
  ];
  assert.equal(computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(anti)).forecastDayR2, 1);
});

test('F21 — degenerate day variance (constant prediction) reads null, never a fake 0 or 1', () => {
  const flat = Array.from({ length: 6 }, () => skillDay(50, 48 + 0)); // identical rows: vx = vy = 0
  assert.equal(
    computeConfidenceSnapshot(emptyDeg, emptyTherm, skillWith(flat)).forecastDayR2,
    null,
  );
});
