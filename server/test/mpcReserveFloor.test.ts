import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendDispatch, type MpcInputs } from '../src/dispatch/mpc.js';

/*
 * v0.93.0 (audit #12) — the MPC planner must never recommend a reserve
 * setpoint BELOW the operator's configured reserveFloorPct.
 *
 * Bug: the legacy `lower` action (deltaReservePct = -10) clamped the DP's
 * allowable reserve at max(0, ...), so it could walk the reserve down to 0%.
 * simulateHour then assessed the reserve-dip penalty against that SAME lowered
 * setpoint — so draining the pack below the real floor incurred no penalty and
 * the DP happily recommended emptying the battery to 0% to serve on-peak load.
 *
 * Fix: floor the DP-allowable reserve at inputs.reserveFloorPct.
 *
 * These tests are deterministic: nowMs is pinned so tariff hour-of-day indexing
 * doesn't depend on wall-clock (CI runs in UTC, dev in local TZ).
 */

const pinnedNowMs = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); })();

test('recommendDispatch — audit #12: no recommended reserve ever falls below reserveFloorPct (drain-incentive scenario)', () => {
  // Construct a scenario that, before the fix, made `lower` maximally
  // attractive: a real TOU spread (25 ¢ on-peak / 5 ¢ off-peak) with heavy
  // on-peak load and NO PV. Serving that load from the battery (lowering the
  // reserve to free up energy) avoids expensive on-peak grid imports. With a
  // full pack and a modest dip penalty measured — pre-fix — against the
  // lowered floor, the DP would walk the reserve down toward 0%.
  const reserveFloorPct = 20;
  const inputs: MpcInputs = {
    currentSocPct: 100,
    reserveFloorPct,
    capacityKwh: 60,
    pvForecastP50: new Array(24).fill(0),
    pvForecastP10: new Array(24).fill(0),
    loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 6.0 : 1.0)),
    tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 25 : 5)),
    gridAvailable: true,
    cyclingCostUsdPerKwh: 0.0,
    reserveDipPenaltyUsdPerKwh: 1.0,
    nowMs: pinnedNowMs,
  };
  const r = recommendDispatch(inputs);

  assert.equal(r.steps.length, 24);
  for (const step of r.steps) {
    assert.ok(
      step.recommendedReservePct >= reserveFloorPct,
      `hour ${step.hour}: recommendedReservePct=${step.recommendedReservePct} is below the operator floor ${reserveFloorPct} (action=${step.action})`,
    );
  }
  for (const rp of r.setpointSchedule) {
    assert.ok(rp >= reserveFloorPct, `setpointSchedule value ${rp} is below the operator floor ${reserveFloorPct}`);
  }
});

test('recommendDispatch — audit #12: floor is respected across a range of reserveFloorPct values', () => {
  for (const reserveFloorPct of [0, 5, 10, 20, 30, 45]) {
    const inputs: MpcInputs = {
      currentSocPct: 100,
      reserveFloorPct,
      capacityKwh: 60,
      pvForecastP50: new Array(24).fill(0),
      pvForecastP10: new Array(24).fill(0),
      loadForecast: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 6.0 : 1.0)),
      tariffOnPeakCentsByHour: Array.from({ length: 24 }, (_, h) => (h >= 15 && h < 20 ? 25 : 5)),
      gridAvailable: true,
      cyclingCostUsdPerKwh: 0.0,
      reserveDipPenaltyUsdPerKwh: 1.0,
      nowMs: pinnedNowMs,
    };
    const r = recommendDispatch(inputs);
    const minReserve = Math.min(...r.setpointSchedule);
    assert.ok(
      minReserve >= reserveFloorPct,
      `floor ${reserveFloorPct}: min recommended reserve ${minReserve} dropped below the floor`,
    );
  }
});
