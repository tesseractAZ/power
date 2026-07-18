import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.38.0 (WS2) — night-charge learning ledger persistence (design §3.1).
 *
 * The write-readiness gate reduces over a MULTI-MONTH verification record, so
 * that record lives in its own DEDICATED, NEVER-PRUNED tables
 * (night_charge_ledger + night_charge_calibration), created alongside
 * lifetime_totals and never referenced by the 30-day samples prune. These tests
 * prove:
 *  (a) a PLAN row round-trips through readNightLedger;
 *  (b) a partial recordNightOutcome merges OUTCOME/SCORE fields onto the SAME
 *      plan_date row WITHOUT clobbering the frozen PLAN columns (the crux — a
 *      naive INSERT-OR-REPLACE would null every omitted plan column);
 *  (c) booleans are coerced to INTEGER 0/1 (node:sqlite rejects a JS boolean bind);
 *  (d) the calibration singleton upserts + reads back, and stays a singleton;
 *  (e) readNightCalibration is null before the first fit.
 */

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-ledger-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION } = await import('../src/nightChargeGate.js');
import type { NightLedgerRow, NightCalibration } from '../src/recorder.js';

const PLAN_DATE = '2026-07-15';

/** A fully-populated frozen PLAN row (design §3.1 plan columns). */
function fullPlan(): Partial<NightLedgerRow> & { plan_date: string } {
  return {
    plan_date: PLAN_DATE,
    issued_at_ms: 1_752_600_000_000,
    algo_version: 'nc-v1',
    posture: 'advisory',
    objective: 'resilience_cushion',
    rationale: 'Buy ~7.2 kWh overnight → target 63%.',
    confidence_tier: 'forecast',
    horizon_hours: 30,
    soc_now_pct: 41,
    soc_at_window_start_pct: 33,
    target_soc_pct: 63,
    buy_kwh: 7.2,
    required_extra_kwh: 6.7,
    reserve_floor_pct: 10,
    cushion_pct: 15,
    cushion_kwh: 13.8,
    binding_cap: 'requirement',
    pv_p10_kwh: 22.1,
    pv_p50_kwh: 34.5,
    pv_p90_kwh: 46.0,
    load_p10_kwh: 18.0,
    load_p50_kwh: 24.0,
    load_p90_kwh: 31.5,
    ev_p90_session_kwh: 26.2,
    ev_session_count: 12,
    min_proj_soc_pct: 25.4,
    min_proj_soc_ts_ms: 1_752_640_800_000,
    pool_full_kwh: 92.16,
    band_sigma_cal: 0.18,
    cal_scored_days: 21,
    forecast_basis: 'forecast',
    weather_covered: 1,
    tariff_snapshot: JSON.stringify({ plan: 'aps_ev', season: 'summer', ratesConfirmed: false }),
  };
}

test('recordNightPlan → readNightLedger round-trips every PLAN column', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    const plan = fullPlan();
    rec.recordNightPlan(plan);

    const rows = rec.readNightLedger(100_000); // huge window → cutoff far in the past
    assert.equal(rows.length, 1, 'exactly one ledger row');
    const row = rows[0];

    for (const [k, v] of Object.entries(plan)) {
      assert.equal((row as any)[k], v, `plan column ${k} round-trips`);
    }
    // Outcome + score columns are NULL until captured.
    assert.equal(row.outcome_captured_at_ms, null);
    assert.equal(row.actual_pv_kwh, null);
    assert.equal(row.plan_traj_floor_breached, null);
    assert.equal(row.scored, null);
    assert.equal(row.buy_err_kwh, null);
  } finally {
    rec.close();
  }
});

test('recordNightOutcome merges OUTCOME/SCORE fields WITHOUT clobbering frozen PLAN columns', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    const plan = fullPlan();
    rec.recordNightPlan(plan);

    // A partial outcome/score update — note it deliberately omits every plan column.
    rec.recordNightOutcome(PLAN_DATE, {
      outcome_captured_at_ms: 1_752_690_000_000,
      actual_pv_kwh: 33.9,
      actual_load_kwh: 25.1,
      actual_window_import_kwh: 8.0,
      actual_grid_to_battery_kwh: 6.9,
      actual_onpeak_import_kwh: 0,
      onpeak_import_occurred: 0,
      actual_min_soc_pct: 24.8,
      actual_min_soc_ts_ms: 1_752_641_000_000,
      plan_traj_floor_breached: 0,
      cushion_breached: 0,
      grid_home_coverage_frac: 0.97,
      outage_during_day: 0,
      scored: 1,
      score_notes: 'clean',
      pv_err_frac: -0.017,
      pv_in_band: 1,
      load_err_frac: 0.046,
      load_in_band: 1,
      buy_err_kwh: 0.3,
      soc_min_err_pct: -0.6,
      realized_cost_cents: null, // rates unconfirmed → null over a fabricated number
      would_have_peak_imported: 0,
    });

    const rows = rec.readNightLedger(100_000);
    assert.equal(rows.length, 1, 'still exactly one row (upsert, not insert)');
    const row = rows[0];

    // Frozen plan columns are intact.
    assert.equal(row.algo_version, 'nc-v1');
    assert.equal(row.objective, 'resilience_cushion');
    assert.equal(row.buy_kwh, 7.2);
    assert.equal(row.target_soc_pct, 63);
    assert.equal(row.reserve_floor_pct, 10);
    assert.equal(row.cushion_pct, 15);
    assert.equal(row.tariff_snapshot, plan.tariff_snapshot);

    // Outcome + score columns are now populated.
    assert.equal(row.actual_pv_kwh, 33.9);
    assert.equal(row.actual_grid_to_battery_kwh, 6.9);
    assert.equal(row.scored, 1);
    assert.equal(row.plan_traj_floor_breached, 0);
    assert.equal(row.buy_err_kwh, 0.3);
    assert.equal(row.pv_in_band, 1);
    assert.equal(row.realized_cost_cents, null);
    // A field never provided by either call stays null.
    assert.equal(row.counterfactual_cost_cents, null);
  } finally {
    rec.close();
  }
});

test('booleans are coerced to INTEGER 0/1 (node:sqlite rejects a JS boolean bind)', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    rec.recordNightPlan(fullPlan());
    // Pass JS booleans (via cast) where the schema stores 0/1 — the recorder
    // must coerce, not throw, and must round-trip as numeric 0/1.
    rec.recordNightOutcome(PLAN_DATE, {
      plan_traj_floor_breached: true as any,
      cushion_breached: false as any,
      scored: true as any,
    });
    const row = rec.readNightLedger(100_000)[0];
    assert.equal(row.plan_traj_floor_breached, 1);
    assert.equal(row.cushion_breached, 0);
    assert.equal(row.scored, 1);
    assert.equal(typeof row.plan_traj_floor_breached, 'number');
  } finally {
    rec.close();
  }
});

test('calibration singleton: null before first fit, then upsert + read round-trips and stays singleton', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    assert.equal(rec.readNightCalibration(), null, 'null before any upsert');

    const cal: NightCalibration = {
      id: 1,
      updated_at_ms: 1_752_600_000_000,
      cushion_pct_summer: 15,
      cushion_pct_winter: 12,
      cushion_pct_monsoon: 20,
      cushion_floor_pct: 10,
      buy_bias_kwh: 0.4,
      ev_p90_inflation: 1.15,
      scored_days: 21,
      exclusion_frac: 0.32,
      algo_version: 'nc-v1',
      state_json: JSON.stringify({ seasons: ['summer', 'winter', 'monsoon'] }),
    };
    rec.upsertNightCalibration(cal);
    // Spread the row into a plain object: node:sqlite returns null-prototype
    // rows, which deepStrictEqual would reject against a plain-object literal.
    assert.deepEqual({ ...rec.readNightCalibration() }, cal, 'round-trips exactly');

    // A second upsert (even with id omitted) updates the SAME singleton row.
    rec.upsertNightCalibration({ ...cal, id: undefined as any, cushion_pct_summer: 18, scored_days: 22 });
    const after = rec.readNightCalibration();
    assert.equal(after?.id, 1);
    assert.equal(after?.cushion_pct_summer, 18);
    assert.equal(after?.scored_days, 22);
    assert.equal(after?.cushion_pct_winter, 12, 'untouched field preserved');
  } finally {
    rec.close();
  }
});

test('readRecorder exposes the ledger over the read connection (worker path)', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    rec.recordNightPlan(fullPlan());
    rec.recordNightOutcome(PLAN_DATE, { scored: 1, actual_pv_kwh: 33.9 });

    // A second (read-only) connection to the same WAL DB sees the committed rows.
    const reader = createReadRecorder(process.env.DB_PATH);
    try {
      const rows = reader.readNightLedger(100_000);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].algo_version, 'nc-v1');
      assert.equal(rows[0].scored, 1);
      assert.equal(rows[0].actual_pv_kwh, 33.9);

      const cal: NightCalibration = {
        id: 1, updated_at_ms: 1, cushion_pct_summer: 15, cushion_pct_winter: 12,
        cushion_pct_monsoon: 20, cushion_floor_pct: 10, buy_bias_kwh: 0,
        ev_p90_inflation: 1, scored_days: 5, exclusion_frac: 0.1,
        algo_version: 'nc-v1', state_json: null,
      };
      rec.upsertNightCalibration(cal);
      assert.deepEqual({ ...reader.readNightCalibration() }, cal);

      // Write stubs on the read recorder are no-ops (worker never writes).
      reader.recordNightPlan({ plan_date: '2000-01-01' });
      reader.recordNightOutcome('2000-01-01', { scored: 1 });
      reader.upsertNightCalibration(cal);
      assert.equal(reader.readNightLedger(100_000).length, 1, 'stub writes changed nothing');
    } finally {
      reader.close();
    }
  } finally {
    rec.close();
  }
});

test('readNightLedger respects the sinceDays cutoff', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    // An ancient plan_date well outside any reasonable window. (Tests in this
    // file share one DB file — config.dbPath is fixed at import — so assert by
    // MEMBERSHIP of this specific date, not an absolute row count.)
    rec.recordNightPlan({ ...fullPlan(), plan_date: '2000-01-01' });
    // sinceDays=1 → cutoff is ~yesterday's Phoenix date, far after 2000-01-01.
    const tight = rec.readNightLedger(1);
    assert.ok(!tight.some((r) => r.plan_date === '2000-01-01'), 'ancient row excluded by tight cutoff');
    // A huge window includes it.
    const huge = rec.readNightLedger(100_000);
    assert.ok(huge.some((r) => r.plan_date === '2000-01-01'), 'ancient row included in a huge window');
  } finally {
    rec.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});


test('v1.38.0 regression — gate counts a recorded row (TEXT algo_version) end-to-end, not excluded', () => {
  // The whole gate was inert because the persisted TEXT algo_version never matched
  // a numeric compare. Record a real plan + a breach outcome through the recorder,
  // read it back, and confirm the gate SEES it (→ BLOCKED, not LEARNING-because-empty).
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    rec.recordNightPlan({ ...fullPlan(), algo_version: String(CURRENT_ALGO_VERSION) });
    rec.recordNightOutcome(PLAN_DATE, { outcome_captured_at_ms: 1_752_680_000_000, scored: 1, plan_traj_floor_breached: 1 });
    const rows = rec.readNightLedger(100_000);
    const r = computeNightChargeReadiness(rows, 1_752_700_000_000, { algoVersion: CURRENT_ALGO_VERSION });
    assert.equal(r.state, 'BLOCKED', 'the recorded floor-breach row must be counted (proves TEXT algo_version matches)');
    assert.equal(r.writeReady, false);
  } finally {
    rec.close();
  }
});
