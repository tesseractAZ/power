import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robustZ, mad, median, MODIFIED_Z_K } from '../src/analytics/mathHelpers.js';

/* ===================================================================
 * v1.1.0 — modified z-score with a variance floor.
 *
 * `z = 0.6745·|x − med| / MAD` is unbounded as MAD → 0, and real telemetry hits
 * that constantly (a circuit idling at one steady value all hour). Observed live,
 * in an operator-facing HA notification:
 *
 *   "West Air conditioner load is 3190 W — 3054 W above its typical 135 W for this
 *    hour (baseline: 14.0 days of history, 1345 samples; z 610.4)."
 *
 * Two failures: the number is meaningless, and the severity gate collapses (every
 * past-floor deviation lands far above Z_WARN, so only `floor` does any work).
 * =================================================================== */

const Z_INFO = 3.5;
const Z_WARN = 5;

test('robustZ: a floor-sized deviation with ZERO scatter scores exactly zAtFloor', () => {
  // This is the continuous form of the old `MAD === 0 → constant` fallbacks.
  assert.equal(robustZ(100 + 500, 100, 0, 500, Z_INFO).toFixed(6), Z_INFO.toFixed(6));
  assert.equal(robustZ(100 - 500, 100, 0, 500, Z_INFO).toFixed(6), Z_INFO.toFixed(6)); // symmetric
});

test('robustZ: under degenerate variance z is simply zAtFloor × (absDev / floor)', () => {
  // "How many floors from typical" — the only honest statement when there is no scatter.
  assert.equal(robustZ(100 + 1000, 100, 0, 500, Z_INFO), Z_INFO * 2);
  assert.equal(robustZ(100 + 2500, 100, 0, 500, Z_INFO), Z_INFO * 5);
});

test('robustZ: the live 610.4 case now scores ~21, not ~610', () => {
  // Live: median 135 W, live 3190 W (absDev 3054), circuit-watt floor 500 W. The hour
  // bucket is dominated by the idle state, so MAD is a few watts.
  const madTiny = 3.4;
  const raw = Math.abs((MODIFIED_Z_K * 3054) / madTiny);
  assert.ok(raw > 600, `raw modified-z should reproduce the absurd value, got ${raw}`);

  const z = robustZ(3190, 135, madTiny, 500, Z_INFO);
  assert.ok(z > 20 && z < 22, `expected ~21.4, got ${z}`);
  // Still a warning — a sustained 3 kW excursion is real. We fixed the number, not the alarm.
  assert.ok(z >= Z_WARN);
});

test('robustZ: a BARE floor-cross with no scatter is INFO, not a warning', () => {
  // The severity-gate restoration. Before, MAD≈0 sent z into the hundreds, so a deviation
  // of exactly the floor was indistinguishable from a 10× excursion — both warned.
  const zBare = robustZ(100 + 500, 100, 0.5, 500, Z_INFO);
  assert.ok(zBare >= Z_INFO, 'still visible');
  assert.ok(zBare < Z_WARN, `a bare floor-cross must not warn, got z=${zBare}`);

  // A warning needs ≈1.43× the floor (Z_WARN / Z_INFO) once variance is degenerate.
  const zWarn = robustZ(100 + 500 * 1.5, 100, 0.5, 500, Z_INFO);
  assert.ok(zWarn >= Z_WARN, `1.5× the floor should warn, got z=${zWarn}`);
});

test('robustZ: REAL scatter is untouched — the true modified z-score is returned', () => {
  // MAD well above the floor-implied minimum ⇒ the genuine statistic must pass through.
  const xs = [10, 30, 50, 70, 90, 110];
  const med = median(xs);
  const m = mad(xs, med);                    // 30 — far above the floor-implied MAD
  const floor = 5;                            // floor-implied MAD = 0.6745*5/3.5 ≈ 0.96
  const expected = Math.abs((MODIFIED_Z_K * (200 - med)) / m);
  assert.equal(robustZ(200, med, m, floor, Z_INFO), expected);
});

test('robustZ: no usable floor falls back to the raw statistic, guarding MAD===0', () => {
  assert.equal(robustZ(10, 0, 2, 0, Z_INFO), Math.abs((MODIFIED_Z_K * 10) / 2));
  assert.equal(robustZ(10, 0, 0, 0, Z_INFO), Z_INFO);   // singularity guarded
});

test('robustZ: z is monotonic in the deviation (a bigger excursion never scores lower)', () => {
  let prev = -Infinity;
  for (const dev of [0, 100, 500, 1000, 3054, 10_000]) {
    const z = robustZ(135 + dev, 135, 3.4, 500, Z_INFO);
    assert.ok(z >= prev, `z must be non-decreasing in deviation (dev=${dev})`);
    prev = z;
  }
});
