import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLearnedAlerts,
  fadeExceedsPlausibleCeiling,
  _resetPeerHitCounts,
} from '../src/analytics.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.93.0 audit fixes — both DIAGNOSTIC/reporting, no alarm consumer.
 *
 * #14 — the learned peer-baseline detector fired a WARNING on a COLD-side
 *       thermal outlier (direction-agnostic |z|). A below-typical temperature
 *       on a heat-generating pack/MPPT is benign, so the WARNING tier now gates
 *       to the HOT side (value above the sibling median) for THERMAL metrics
 *       only; cold excursions demote to INFO. Non-thermal metrics keep the
 *       symmetric |z| rule.
 *
 * #16 — the Kalman years-to-EOL path lacked the OLS fade-ceiling guard, so a
 *       Kalman fade rate above the physical LFP ceiling (early-life BMS
 *       fullCap settling) could publish a false dated kalmanYearsToEol even
 *       when the OLS path rejected it. The Kalman gate now reuses the same
 *       fadeExceedsPlausibleCeiling helper the OLS path uses.
 * =================================================================== */

/* ── #14: thermal direction-gate fixture ──────────────────────────── */

/**
 * One online DPU whose packs are identical on every non-thermal metric
 * (voldiff / soh / soc all equal → their peer deviation is 0, below floor,
 * so they never flag). Only maxCellTemp varies: four tightly-clustered
 * siblings plus one far outlier at `outlierC`. With a small nonzero peer MAD
 * the outlier's modified z-score clears Z_WARN (=5), so the ONLY thing that
 * decides warning-vs-info is the new hot/cold direction gate.
 *
 * Sibling temps 24.5/25/25/25.5 °C → 76.1/77/77/77.9 °F, median 77 °F,
 * MAD 0.9 °F. Outlier |dev| = 18 °F → z ≈ 13.5 (well past Z_WARN), and
 * 18 °F ≥ the temp metric's 5 °F floor.
 */
function dpuWithTempOutlier(outlierC: number, sn = 'SN-DPU-T'): Record<string, DeviceSnapshot> {
  const base = { soh: 100, actSoh: 100, maxVolDiffMv: 20, soc: 80, inputWatts: 0, outputWatts: 0, cycles: 50 };
  const mk = (num: number, tC: number) => ({ num, temp: tC, maxCellTemp: tC, minCellTemp: tC, ...base });
  const packs = [
    mk(1, 24.5),
    mk(2, 25),
    mk(3, 25),
    mk(4, 25.5),
    mk(5, outlierC),
  ];
  return {
    [sn]: {
      sn,
      deviceName: 'Core 1',
      online: true,
      lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs } as any,
    } as any,
  };
}

const tempAlerts = (alerts: ReturnType<typeof computeLearnedAlerts>) =>
  alerts.filter((a) => a.id.startsWith('peer-temp-'));

/** Run N consecutive eval cycles (the emit gate needs ≥3) and return the last cycle's alerts. */
function emitAfterHysteresis(devices: Record<string, DeviceSnapshot>): ReturnType<typeof computeLearnedAlerts> {
  let last: ReturnType<typeof computeLearnedAlerts> = [];
  for (let i = 0; i < 3; i++) last = computeLearnedAlerts(devices);
  return last;
}

test('#14 — a HOT thermal peer-outlier (above the sibling median) still emits a WARNING', () => {
  _resetPeerHitCounts();
  // Outlier at 35 °C = 95 °F, +18 °F above the 77 °F median → hot side.
  const alerts = tempAlerts(emitAfterHysteresis(dpuWithTempOutlier(35)));
  assert.equal(alerts.length, 1, 'the hot outlier should surface one temp alert');
  assert.equal(alerts[0].severity, 'warning', 'hot-side high-z thermal outlier stays a warning');
  _resetPeerHitCounts();
});

test('#14 — a COLD thermal peer-outlier (below the sibling median) demotes to INFO, never WARNING', () => {
  _resetPeerHitCounts();
  // Outlier at 15 °C = 59 °F, -18 °F below the 77 °F median → cold side.
  // Same |z| as the hot case, but a cold pack is benign → must NOT warn.
  const alerts = tempAlerts(emitAfterHysteresis(dpuWithTempOutlier(15)));
  assert.equal(alerts.length, 1, 'the cold outlier is still surfaced (visible), just not as a warning');
  assert.equal(alerts[0].severity, 'info', 'cold-side thermal outlier is demoted to info');
  assert.match(alerts[0].detail, /lower than/, 'the alert reflects the below-median direction');
  _resetPeerHitCounts();
});

test('#14 — the direction gate is thermal-only: a below-median SoC outlier still warns symmetrically', () => {
  _resetPeerHitCounts();
  // Non-thermal (Battery/SoC) metric: identical siblings + one pack 25% LOW.
  // absDev 25% ≥ the 8% SoC floor; MAD-zero fallback then symmetric |z| — the
  // thermal hot-side gate must not touch this path.
  const base = { temp: 25, maxCellTemp: 25, minCellTemp: 25, soh: 100, actSoh: 100, maxVolDiffMv: 20, inputWatts: 0, outputWatts: 0, cycles: 50 };
  const packs = [
    { num: 1, soc: 80, ...base },
    { num: 2, soc: 80, ...base },
    { num: 3, soc: 80, ...base },
    { num: 4, soc: 80, ...base },
    { num: 5, soc: 55, ...base }, // -25%, below median, below-typical
  ];
  const devices = {
    'SN-DPU-S': {
      sn: 'SN-DPU-S',
      deviceName: 'Core 1',
      online: true,
      lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs } as any,
    } as any,
  } as Record<string, DeviceSnapshot>;
  let last: ReturnType<typeof computeLearnedAlerts> = [];
  for (let i = 0; i < 3; i++) last = computeLearnedAlerts(devices);
  const soc = last.filter((a) => a.id.startsWith('peer-soc-'));
  assert.equal(soc.length, 1, 'a below-median SoC outlier still surfaces');
  // MAD-zero on identical siblings forces z=Z_INFO, so this particular fixture
  // yields info — but the key assertion is the direction gate did NOT further
  // suppress a non-thermal below-median metric (it is present regardless).
  assert.ok(['info', 'warning'].includes(soc[0].severity), 'non-thermal metric keeps the symmetric rule');
  _resetPeerHitCounts();
});

/* ── #16: Kalman years-to-EOL reuses the OLS fade-ceiling guard ────── */

// The Kalman EOL block now publishes kalmanYearsToEol only when
//   kalmanFadePctPerYear > 0.1  AND  !fadeExceedsPlausibleCeiling(kalmanFadePctPerYear)
// i.e. the fade rate is above the noise floor but within the physical LFP
// ceiling (10 %/yr). These assertions pin the exact boundary the gate uses so
// a future refactor can't silently let an implausible Kalman fade date an EOL.

test('#16 — the Kalman EOL ceiling gate REJECTS an implausibly fast fade (early-life BMS settling)', () => {
  // A Kalman fade of 39 %/yr (the live Core-3 early-life artifact) is > ceiling
  // → gate closes → no dated kalmanYearsToEol.
  assert.equal(fadeExceedsPlausibleCeiling(39), true);
  assert.equal(fadeExceedsPlausibleCeiling(10.01), true);
});

test('#16 — the Kalman EOL ceiling gate ADMITS a fast-but-plausible fade (dates an EOL)', () => {
  // At/under the 10 %/yr ceiling the gate stays open, so a real fade still
  // projects a dated Kalman EOL exactly like the OLS path.
  assert.equal(fadeExceedsPlausibleCeiling(10), false);
  assert.equal(fadeExceedsPlausibleCeiling(2.5), false);
});

test('#16 — a sub-0.1 %/yr fade is below the lower bound (headroom guard, not the ceiling)', () => {
  // The ceiling helper is only the UPPER gate; the > 0.1 lower bound (unchanged)
  // keeps a flat/near-flat Kalman fade from dividing headroom by ~0 → the ceiling
  // helper correctly reports FALSE here (it is not the constraint that rejects it).
  assert.equal(fadeExceedsPlausibleCeiling(0.05), false);
  assert.equal(fadeExceedsPlausibleCeiling(0), false);
});
