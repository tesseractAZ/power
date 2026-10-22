import './helpers/siteZoneIsHostZone.js'; // v1.191.0 — fixtures on the host clock: the site zone is the host's (first import)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diurnalBaselinePredictor } from '../src/analytics.js';

/**
 * v0.13.3 — P3-4: the GET /api/backtest/forecast baseline predictor used to be a
 * FLAT constant (typicalPvWhPerDay / 24) applied to night and noon alike, which
 * scored R² ≈ 0. The reports.ts `backtest` builder now builds the predictor via
 * diurnalBaselinePredictor(curve) when a 24-slot hour-of-day curve is passed,
 * else falls back to the flat scalar. These tests pin the diurnal predictor — the
 * substantive new behavior (the flat fallback is the unchanged `() => scalar`).
 */

test('diurnalBaselinePredictor — predicts curve[hourOfDay]: noon = peak, 2am ≈ 0', () => {
  const curve = new Array(24).fill(0);
  curve[12] = 5000; // noon peak, Wh/h
  curve[13] = 4800;
  const predict = diurnalBaselinePredictor(curve);

  const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  assert.equal(predict(at(12)), 5000, 'noon → curve[12] (peak)');
  assert.equal(predict(at(13)), 4800, '1pm → curve[13]');
  assert.equal(predict(at(2)), 0, '2am → curve[2] = 0 (no flat night PV — the old bug)');
  // The whole point of P3-4: night and noon predictions DIFFER (a flat baseline can't).
  assert.notEqual(predict(at(2)), predict(at(12)));
});

test('diurnalBaselinePredictor — defensively normalizes a non-24-slot curve to finite slots', () => {
  const predict = diurnalBaselinePredictor([1000, 2000]); // too short — must not throw
  const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  for (const h of [0, 6, 12, 18, 23]) {
    assert.ok(Number.isFinite(predict(at(h))), `hour ${h} yields a finite prediction`);
  }
});
