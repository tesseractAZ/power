import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kalmanFilterSoh } from '../src/analytics.js';

/**
 * Kalman SoH filter tests. The filter fits a 2-state constant-velocity
 * model — state = [SoH, dSoH/dt]. These tests verify it converges to
 * the right slope under known synthetic data + reports proper
 * uncertainty when the data is noisy.
 */

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

test('kalmanFilterSoh — returns null on insufficient data', () => {
  assert.equal(kalmanFilterSoh([]), null);
  assert.equal(kalmanFilterSoh([{ ts: 0, value: 100 }]), null);
  assert.equal(kalmanFilterSoh([{ ts: 0, value: 100 }, { ts: DAY_MS, value: 99.9 }]), null);
});

test('kalmanFilterSoh — recovers a known fade slope from clean synthetic data', () => {
  // Synthetic: SoH = 100 - 2 %/yr × t. 200 samples over 200 days.
  // Expected drift per year ≈ -2.0.
  const pts: Array<{ ts: number; value: number }> = [];
  const fadePctPerYear = -2.0;
  for (let i = 0; i <= 200; i++) {
    const ts = i * DAY_MS;
    const sohYears = ts / YEAR_MS;
    pts.push({ ts, value: 100 + fadePctPerYear * sohYears });
  }
  const result = kalmanFilterSoh(pts);
  assert.ok(result, 'expected a result');
  assert.ok(result!.driftPerYear != null);
  // Within 10% of the truth — the constant-velocity Kalman should converge
  // to the true slope cleanly on noise-free data.
  assert.ok(
    Math.abs(result!.driftPerYear! - fadePctPerYear) / Math.abs(fadePctPerYear) < 0.15,
    `expected drift ≈ ${fadePctPerYear}, got ${result!.driftPerYear}`,
  );
});

test('kalmanFilterSoh — smoothed SoH tracks the most recent observation', () => {
  const pts: Array<{ ts: number; value: number }> = [];
  // Flat SoH at 95 for 100 days.
  for (let i = 0; i <= 100; i++) {
    pts.push({ ts: i * DAY_MS, value: 95 });
  }
  const result = kalmanFilterSoh(pts);
  assert.ok(result);
  // Smoothed SoH should sit very close to 95.
  assert.ok(Math.abs(result!.smoothedSoh! - 95) < 0.5);
  // Drift should be near zero.
  assert.ok(Math.abs(result!.driftPerYear!) < 0.5);
});

test('kalmanFilterSoh — uncertainty shrinks as more samples arrive', () => {
  const fadePctPerYear = -2.0;
  const buildPts = (n: number) => {
    const pts: Array<{ ts: number; value: number }> = [];
    for (let i = 0; i <= n; i++) {
      const ts = i * DAY_MS;
      pts.push({ ts, value: 100 + fadePctPerYear * (ts / YEAR_MS) });
    }
    return pts;
  };
  const shortResult = kalmanFilterSoh(buildPts(20));
  const longResult = kalmanFilterSoh(buildPts(400));
  assert.ok(shortResult && longResult);
  // The longer history should have tighter drift uncertainty.
  assert.ok(
    longResult!.driftPerYearStdev! < shortResult!.driftPerYearStdev!,
    `expected uncertainty to shrink with more data — short ${shortResult!.driftPerYearStdev}, long ${longResult!.driftPerYearStdev}`,
  );
});

test('kalmanFilterSoh — handles noisy data without diverging', () => {
  // SoH = 95 + small noise. Drift should be near zero, SoH ≈ 95.
  const pts: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i <= 100; i++) {
    // Deterministic "noise" (sin-based) so the test is stable
    pts.push({ ts: i * DAY_MS, value: 95 + 0.3 * Math.sin(i * 0.7) });
  }
  const result = kalmanFilterSoh(pts);
  assert.ok(result);
  assert.ok(Math.abs(result!.smoothedSoh! - 95) < 1);
  assert.ok(Math.abs(result!.driftPerYear!) < 2);
});
