import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * v1.187.22 — the night ledger records the plan's EXPECTED buy and expected window-open SoC beside
 * `buy_kwh` (the worst case, unchanged), and the scorer records the pool SoC MEASURED as the window
 * opened. Until now the ledger could not say where the pool opened the window: on 2026-10-12 the
 * plan sized from 16.9% and the pool was at 46%, which only a live read showed.
 *
 * The migration is tested on a database created with the original (v1.38.0) table: the recorder's
 * column-add pass must give it the new columns, an existing row must read them as NULL, and a
 * column missing from the allowlist or the ALTER would drop writes SILENTLY.
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-expected-'));
const DB = join(tmp, 'ecoflow.db');
process.env.DB_PATH = DB;

// The night_charge_ledger as v1.38.0 created it (recorder.ts CREATE TABLE): none of the
// columns added since, so every one of them arrives through the migration.
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE night_charge_ledger (
    plan_date TEXT PRIMARY KEY, issued_at_ms INTEGER, algo_version TEXT, posture TEXT, objective TEXT,
    rationale TEXT, confidence_tier TEXT, horizon_hours REAL, soc_now_pct REAL, soc_at_window_start_pct REAL,
    target_soc_pct REAL, buy_kwh REAL, required_extra_kwh REAL, reserve_floor_pct REAL, cushion_pct REAL,
    cushion_kwh REAL, binding_cap TEXT, pv_p10_kwh REAL, pv_p50_kwh REAL, pv_p90_kwh REAL, load_p10_kwh REAL,
    load_p50_kwh REAL, load_p90_kwh REAL, ev_p90_session_kwh REAL, ev_session_count INTEGER,
    min_proj_soc_pct REAL, min_proj_soc_ts_ms INTEGER, pool_full_kwh REAL, band_sigma_cal REAL,
    cal_scored_days INTEGER, forecast_basis TEXT, weather_covered INTEGER, tariff_snapshot TEXT,
    outcome_captured_at_ms INTEGER, actual_pv_kwh REAL, actual_load_kwh REAL, actual_window_import_kwh REAL,
    actual_grid_to_battery_kwh REAL, actual_onpeak_import_kwh REAL, onpeak_import_occurred INTEGER,
    actual_min_soc_pct REAL, actual_min_soc_ts_ms INTEGER, plan_traj_floor_breached INTEGER,
    cushion_breached INTEGER, grid_home_coverage_frac REAL, outage_during_day INTEGER, scored INTEGER,
    score_notes TEXT, pv_err_frac REAL, pv_in_band INTEGER, load_err_frac REAL, load_in_band INTEGER,
    buy_err_kwh REAL, soc_min_err_pct REAL, realized_cost_cents REAL, counterfactual_cost_cents REAL,
    realized_savings_cents REAL, demand_charge_savings_cents REAL, would_have_peak_imported INTEGER
  )`);
  db.prepare(`INSERT INTO night_charge_ledger (plan_date, issued_at_ms, buy_kwh, soc_at_window_start_pct) VALUES (?, ?, ?, ?)`)
    .run('2026-09-01', 1, 30.5, 12.4);
  db.close();
}

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { expectedBuyLedgerColumns } = await import('../src/nightChargeAdvisor.js');
const { measuredWindowOpenSocPct, expectedBuyScoreNote, WINDOW_OPEN_SOC_LEAD_MS } = await import('../src/nightLedgerScoring.js');

const COLS = ['expected_buy_kwh', 'expected_start_soc_pct', 'window_open_soc_pct'] as const;
const base = (d: string) => ({ plan_date: d, issued_at_ms: 2, algo_version: '3', posture: 'auto', objective: 'cost_arbitrage',
  rationale: 'x', confidence_tier: 'forecast', horizon_hours: 25, soc_now_pct: 53, soc_at_window_start_pct: 17.6,
  target_soc_pct: 80.4, buy_kwh: 63.92, required_extra_kwh: 23, reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 13.9,
  binding_cap: 'requirement' });

test('★★★ an old-schema ledger gains the columns; the old row reads NULL; plan and outcome writes round-trip', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const cols = (new DatabaseSync(DB).prepare('PRAGMA table_info(night_charge_ledger)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of COLS) assert.ok(cols.includes(c), `${c} added by the migration`);
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    // The pre-existing row: kept as recorded, the new columns NULL — never fabricated.
    assert.equal(at('2026-09-01').buy_kwh, 30.5);
    for (const c of COLS) assert.equal(at('2026-09-01')[c], null, `${c} is null on an old row`);
    // The plan row writes both plan columns from the plan (expectedBuyLedgerColumns).
    rec.recordNightPlan({ ...base('2026-10-12'), ...expectedBuyLedgerColumns({ expectedBuyKwh: 34.88, expectedStartSocPct: 44.9 }) } as never);
    assert.deepEqual([at('2026-10-12').expected_buy_kwh, at('2026-10-12').expected_start_soc_pct], [34.88, 44.9]);
    assert.equal(at('2026-10-12').buy_kwh, 63.92, 'buy_kwh keeps the worst case');
    // The scorer's outcome merge adds the measured window-open SoC without touching the plan columns.
    rec.recordNightOutcome('2026-10-12', { window_open_soc_pct: 46, scored: 1 });
    assert.deepEqual(COLS.map((c) => at('2026-10-12')[c]), [34.88, 44.9, 46]);
    // A re-issued plan with no expected figure replaces it (written unconditionally, null with none).
    rec.recordNightPlan({ ...base('2026-10-12'), ...expectedBuyLedgerColumns({}) } as never);
    assert.deepEqual([at('2026-10-12').expected_buy_kwh, at('2026-10-12').expected_start_soc_pct], [null, null]);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('measuredWindowOpenSocPct: the median over the lead-in — a reconnect 0 cannot stand in for the pool', () => {
  const WS = 1_000_000_000;
  const pts = [
    { ts: WS - WINDOW_OPEN_SOC_LEAD_MS - 60_000, value: 60 }, // before the lead-in
    { ts: WS - 10 * 60_000, value: 46 },
    { ts: WS - 6 * 60_000, value: 0 }, // the SHP2's single-sample reconnect artifact
    { ts: WS - 2 * 60_000, value: 46 },
    { ts: WS, value: 45.5 },
    { ts: WS + 60_000, value: 47 }, // charging has begun
  ];
  assert.equal(measuredWindowOpenSocPct(pts, WS), 45.8, 'median of 46, 0, 46, 45.5 = (45.5 + 46) / 2');
  assert.equal(measuredWindowOpenSocPct(pts.slice(0, 1), WS), null, 'nothing in the lead-in');
  assert.equal(measuredWindowOpenSocPct([], WS), null);
  assert.equal(measuredWindowOpenSocPct([{ ts: WS - 60_000, value: Number.NaN }, { ts: WS, value: 46.04 }], WS), 46);
});

test('expectedBuyScoreNote: expected against delivered and the measured open, the sizing start beside it', () => {
  assert.equal(expectedBuyScoreNote({ expectedBuyKwh: 34.88, expectedStartSocPct: 44.9, sizingStartSocPct: 17.6,
    windowOpenSocPct: 46, actuated: true, deliveredKwh: 33.1 }),
  ' Expected buy ~34.88 kWh, delivered 33.1 kWh (0.95× expected); window-open SoC expected ~44.9%, measured 46% (the islanded sizing start was 17.6%).');
  assert.equal(expectedBuyScoreNote({ expectedBuyKwh: 34.88, expectedStartSocPct: 44.9, sizingStartSocPct: 17.6,
    windowOpenSocPct: 46, actuated: false, deliveredKwh: null }),
  ' Expected buy ~34.88 kWh (not actuated — nothing delivered to compare); window-open SoC expected ~44.9%, measured 46% (the islanded sizing start was 17.6%).');
  assert.match(expectedBuyScoreNote({ expectedBuyKwh: 34.88, expectedStartSocPct: null, sizingStartSocPct: null,
    windowOpenSocPct: null, actuated: true, deliveredKwh: null }), /^ Expected buy ~34\.88 kWh, delivered unmeasured\.$/);
  assert.match(expectedBuyScoreNote({ expectedBuyKwh: 0, expectedStartSocPct: 66, sizingStartSocPct: 20,
    windowOpenSocPct: null, actuated: true, deliveredKwh: 1.2 }), /delivered 1\.2 kWh; window-open SoC expected ~66%, measured unavailable/);
  assert.equal(expectedBuyScoreNote({ expectedBuyKwh: null, expectedStartSocPct: null, sizingStartSocPct: 17.6,
    windowOpenSocPct: 46, actuated: true, deliveredKwh: 33 }), '', 'a row from before v1.187.22 gains no clause');
});
