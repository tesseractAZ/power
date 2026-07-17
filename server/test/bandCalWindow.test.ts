import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProbabilisticForecast,
  resetForecastCachesForTesting,
  PV_BAND_CAL_WINDOW_DAYS,
} from '../src/analytics.js';
import type { ForecastSkillReport, DayForecast } from '../src/analytics.js';
import { setWeatherCacheForTesting, clearWeatherTestOverride } from '../src/weather.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ===================================================================
 * v1.30.0 — band-calibration WINDOW fix (audit finding).
 *
 * The F30 calibration (v1.23.0) gates on ≥14 weather-covered SCORED
 * days, but the probabilisticForecast builder fed it the DEFAULT 7-day
 * skill window — structurally below the gate at any coverage — so
 * bandSigmaCal sat pinned at 1 in production since ship (live band
 * ±76% of daily P50 vs realized q80 error 7.1%). The v1.23.0 unit
 * tests missed it because every fixture was an ideal ≥14-scored-day
 * report; production never produces one from a 7- or even 14-day
 * calendar window (live coverage ≈ 64% → 9 scored of 14).
 *
 * These tests encode the REALISTIC scenario: partial coverage. The
 * window must be wide enough that the gate is satisfiable at the
 * coverage the fleet actually exhibits.
 * =================================================================== */

/** count scored (weather-covered) days out of `total`, alternating gaps the
 *  way real storm/telemetry-gap exclusions land — coverage ≈ scored/total. */
function partialCoverageDays(
  total: number, scored: number, absErrPct: number,
): ForecastSkillReport['days'] {
  return Array.from({ length: total }, (_, i) => {
    const covered = i < scored; // order is irrelevant to the quantile
    return {
      date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      predictedKwh: 50,
      actualKwh: 50 * (1 + absErrPct / 100),
      errorKwh: covered ? (50 * absErrPct) / 100 : 0,
      errorPct: covered ? absErrPct : null,
      weatherCovered: covered,
    };
  });
}

function forecast24(): DayForecast {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const start = base.getTime() + DAY;
  const hours = Array.from({ length: 24 }, (_, h) => ({
    ts: start + h * HOUR,
    forecastPvW: h >= 7 && h <= 18 ? 3_000 : 0,
    forecastLoadW: 1_000,
    projectedSocPct: 50 + h * 0.5,
  }));
  return { hours, reserveSoc: 20, pvCeilingW: 20_000, deviceModels: [{}, {}, {}] } as unknown as DayForecast;
}

const skillReport = (
  days: ForecastSkillReport['days'], windowDays: number,
): ForecastSkillReport => ({
  generatedAt: 0, days, meanAbsErrorKwh: 3, meanAbsErrorPct: 6, biasFactor: 1, windowDays,
});

beforeEach(() => { resetForecastCachesForTesting(); setWeatherCacheForTesting(null); });
afterEach(() => { clearWeatherTestOverride(); delete process.env.PV_BAND_SIGMA_CAL; });

test('v1.30.0 — the calibration window clears the 14-scored-day gate with coverage headroom', () => {
  // The gate counts SCORED days; the window bounds CALENDAR days. At the
  // fleet's observed ~64% scoring coverage a 14-day window tops out at ~9
  // scored days; 14 scored days at ≥~47% coverage needs a ≥30-day window.
  // A window ≤ the gate (the shipped v1.23.0 wiring: 7) is unsatisfiable at
  // ANY coverage — this pin fails loudly if a refactor narrows it again.
  assert.ok(PV_BAND_CAL_WINDOW_DAYS >= 30,
    `window ${PV_BAND_CAL_WINDOW_DAYS} must give the 14-scored-day gate ~2× calendar headroom`);
});

test('v1.30.0 — REALISTIC partial coverage: 30-day window at ~63% coverage ACTIVATES the calibration', async () => {
  // 19 scored of 30 calendar days (≈ the live fleet's coverage), tight 8%
  // errors → the gate (14) is met and the shrink engages (floored at 0.4).
  const r = await computeProbabilisticForecast(
    forecast24(), skillReport(partialCoverageDays(30, 19, 8), 30),
  );
  assert.ok(r.bandSigmaCal != null && r.bandSigmaCal < 1,
    `calibration must engage on a realistic 30d/63%-coverage sample; got cal=${r.bandSigmaCal}`);
  assert.ok(r.realizedDailyErrHalfFrac != null && r.realizedDailyErrHalfFrac > 0);
  for (const b of r.hours) { assert.ok(b.p10W <= b.p50W && b.p50W <= b.p90W); }
});

test('v1.30.0 — the same coverage on a 14-day window CANNOT activate (why 14 was insufficient)', async () => {
  // 9 scored of 14 calendar days — the exact live measurement that showed a
  // days=14 feed still leaves the calibrator dormant.
  const r = await computeProbabilisticForecast(
    forecast24(), skillReport(partialCoverageDays(14, 9, 8), 14),
  );
  assert.equal(r.bandSigmaCal, 1, '9 scored days is below the 14-scored gate');
  assert.equal(r.realizedDailyErrHalfFrac, null);
});
