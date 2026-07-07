import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAdvisory, type LoadCompositionEntry, type RunwayLike } from '../src/loadShedAdvisor.js';

/**
 * v0.92.0 — audit findings #6 (grid-blind advisor) + #11 (zero-benefit actionable).
 */

// hoursToReserve=2 → an actionable band; toReserveEnergy = 14-4 = 10 kWh @ 2h = 5 kW net.
const RUNWAY: RunwayLike = {
  generatedAt: 0,
  hoursToReserve: 2,
  hoursToEmpty: 4,
  unavailable: null,
  backupRemainingKwh: 14,
  backupReserveKwh: 4,
};

function load(watts: number): LoadCompositionEntry {
  return {
    entityId: 'switch.pool_pump', label: 'Pool pump', priority: 1,
    currentlyOn: true, available: true, measuredWatts: watts,
    source: 'ha_power_sensor', flaggedKeyword: null,
  };
}

const BASE = { now: 0, thresholdHours: 4, restoreMarginHours: 2 };

test('#6 grid-blind: while the grid is backstopping, band is null and NOT actionable', () => {
  const withGrid = computeAdvisory({ ...BASE, runway: RUNWAY, composition: [load(3000)],
    grid: { present: true, backstopping: true } });
  assert.equal(withGrid.band, null, 'grid backstopping → classifyRunway null → no band');
  assert.equal(withGrid.actionable, false, 'no shed recommended while the grid carries the floor');
  assert.match(withGrid.note, /grid backstopping/i);

  // Same state with NO grid → the depletion is real and a big shed IS actionable.
  const noGrid = computeAdvisory({ ...BASE, runway: RUNWAY, composition: [load(3000)] });
  assert.notEqual(noGrid.band, null, 'off-grid: a real depletion band');
  assert.equal(noGrid.actionable, true, 'a 3 kW shed off a 5 kW draw meaningfully helps');
});

test('#11 zero-benefit: a negligible shed is recommended-but-NOT-actionable', () => {
  // 70 W off a 5 kW draw leaves hoursToReserve essentially unchanged (2.0 → ~2.0).
  const a = computeAdvisory({ ...BASE, runway: RUNWAY, composition: [load(70)] });
  assert.notEqual(a.band, null, 'off-grid: in an actionable band');
  assert.equal(a.recommended.length, 1, 'the tiny load is still surfaced as a candidate');
  assert.equal(a.actionable, false, 'but it buys no meaningful runway → not actionable');
  assert.match(a.note, /not meaningfully extend|no actionable/i);
});
