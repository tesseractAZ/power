import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargeReadiness,
  nightChargeGateFields,
  getLatestReadiness,
  setLatestReadiness,
  CURRENT_ALGO_VERSION,
  type NightChargeReadiness,
} from '../src/nightChargeGate.js';
import type { NightLedgerRow } from '../src/recorder.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeGate — write-readiness gate (WS3, design §5).
 *
 * The gate is a PURE reduction over the night_charge_ledger. These tests pin the
 * fail-CLOSED behaviour that keeps a life-safety off-grid home from ever being
 * green-lit for writes on a thin/young/biased record:
 *   - all-clean-but-too-few → LEARNING (fail-closed)
 *   - one plan-trajectory floor breach → BLOCKED (single event, any sample)
 *   - under-buy streak → BLOCKED (under-buy is a safety miss, §5.1)
 *   - a full clean in-season record → READY_TO_CONSIDER_WRITES
 *   - null readiness → write_ready strictly false
 * plus prior-algo exclusion, climatology non-eligibility, MNAR exclusion cap,
 * band over-coverage, and autocorrelation-adjusted effectiveN.
 * ═════════════════════════════════════════════════════════════════════════ */

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 17, 4, 30); // ~21:30 Phoenix on 2026-07-17

/** Build one ledger row with clean, ready-contributing defaults; override any
 *  field. Cast through unknown because WS2 owns the full NightLedgerRow shape —
 *  the gate only reads the §3.1 subset set here. */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): NightLedgerRow {
  const base: Record<string, unknown> = {
    plan_date: '2026-01-01',
    algo_version: CURRENT_ALGO_VERSION,
    issued_at_ms: NOW - 30 * DAY_MS,
    confidence_tier: 'forecast',
    outcome_captured_at_ms: NOW - 29 * DAY_MS,
    scored: 1,
    plan_traj_floor_breached: 0,
    buy_err_kwh: 0.5, // slight over-buy, no under-buy
    pv_err_frac: 0.05,
    load_err_frac: 0.05,
    pv_in_band: 1,
    load_in_band: 1,
    grid_home_coverage_frac: 0.95,
  };
  return { ...base, ...overrides } as unknown as NightLedgerRow;
}

/**
 * A clean, in-season, ready-worthy ledger of `n` nights spanning `n` days.
 * - oldest row `n` days ago (> the 90-day in-season window for n≥100)
 * - band coverage held at 85% (inside [78%,92%]; a naive all-in-band ledger
 *   would OVER-cover at 100% and fail the upper bound)
 * - alternating PV/load residuals → low autocorrelation → high effectiveN
 */
function cleanLedger(n: number, mut?: (r: Record<string, unknown>, i: number) => void): NightLedgerRow[] {
  const rows: NightLedgerRow[] = [];
  for (let i = 0; i < n; i++) {
    const daysAgo = n - i; // i=0 is the oldest
    const issued = NOW - daysAgo * DAY_MS;
    const inBand = i % 20 < 17 ? 1 : 0; // 85% coverage
    const r: Record<string, unknown> = {
      plan_date: new Date(issued).toISOString().slice(0, 10),
      algo_version: CURRENT_ALGO_VERSION,
      issued_at_ms: issued,
      confidence_tier: 'forecast',
      outcome_captured_at_ms: issued + DAY_MS,
      scored: 1,
      plan_traj_floor_breached: 0,
      buy_err_kwh: 0.5,
      pv_err_frac: i % 2 ? 0.05 : -0.05,
      load_err_frac: i % 2 ? 0.05 : -0.05,
      pv_in_band: inBand,
      load_in_band: inBand,
      grid_home_coverage_frac: 0.95,
    };
    if (mut) mut(r, i);
    rows.push(r as unknown as NightLedgerRow);
  }
  return rows;
}

/* ── null / holder basics ─────────────────────────────────────────────── */

test('nightChargeGateFields — null readiness is fail-closed', () => {
  const f = nightChargeGateFields(null);
  assert.equal(f.night_charge_write_ready, false);
  assert.equal(f.night_charge_readiness, 'unknown');
  assert.equal(f.night_charge_under_buy_rate, null);
  assert.equal(f.night_charge_band_coverage_pct, null);
  assert.equal(f.night_charge_plan_nights_scored, null);
  assert.equal(f.night_charge_effective_n, null);
  assert.equal(f.night_charge_forecast_basis_pct, null);
  assert.equal(f.night_charge_exclusion_fraction, null);
});

test('latest-readiness holder round-trips', () => {
  const r = computeNightChargeReadiness([], NOW);
  setLatestReadiness(r);
  assert.equal(getLatestReadiness(), r);
});

/* ── empty / too-few → LEARNING (fail-closed) ─────────────────────────── */

test('empty ledger → LEARNING, not ready', () => {
  const r = computeNightChargeReadiness([], NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
  assert.equal(r.scoredDays, 0);
  assert.ok(r.blocking.length > 0);
});

test('all-clean but too few days → LEARNING (fail-closed)', () => {
  const r = computeNightChargeReadiness(cleanLedger(10), NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
  assert.equal(r.scoredDays, 10);
  // no floor breach → not BLOCKED, and blocked on sample size + in-season span
  assert.ok(r.blocking.some((b) => /scored forecast-backed night/.test(b)));
  assert.ok(r.blocking.some((b) => /in-season/.test(b)));
});

/* ── a full clean in-season record → READY ────────────────────────────── */

test('enough clean in-season scored days → READY_TO_CONSIDER_WRITES', () => {
  const r = computeNightChargeReadiness(cleanLedger(100), NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES', r.blocking.join(' | '));
  assert.equal(r.writeReady, true);
  assert.deepEqual(r.blocking, []);
  assert.equal(r.scoredDays, 100);
  assert.ok(r.effectiveN >= 45);
  assert.ok((r.metrics.bandCoveragePct as number) >= 78 && (r.metrics.bandCoveragePct as number) <= 92);

  const f = nightChargeGateFields(r);
  assert.equal(f.night_charge_write_ready, true);
  assert.equal(f.night_charge_readiness, 'READY_TO_CONSIDER_WRITES');
  assert.equal(f.night_charge_plan_nights_scored, 100);
  assert.equal(f.night_charge_under_buy_rate, 0);
});

/* ── HARD: floor breach → BLOCKED (single event, any sample) ───────────── */

test('one plan-trajectory floor breach → BLOCKED / not ready', () => {
  const rows = cleanLedger(100, (r, i) => {
    if (i === 42) r.plan_traj_floor_breached = 1;
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.writeReady, false);
  assert.equal(r.metrics.floorBreaches, 1);
  assert.ok(r.blocking.some((b) => /floor breach/.test(b)));
});

test('a single floor breach blocks even a tiny ledger', () => {
  const rows = cleanLedger(3, (r, i) => {
    if (i === 0) r.plan_traj_floor_breached = true; // boolean form
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.writeReady, false);
});

/* ── HARD: under-buy streak → BLOCKED (safety miss) ───────────────────── */

test('under-buy streak → BLOCKED / not ready', () => {
  // 20 of 100 nights under-bought → 20% > 10% cap.
  const rows = cleanLedger(100, (r, i) => {
    if (i < 20) r.buy_err_kwh = -2;
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.writeReady, false);
  assert.ok((r.metrics.underBuyRate as number) > 0.1);
  assert.ok(r.blocking.some((b) => /under-buy/.test(b)));
});

test('under-buy on too-few nights stays LEARNING, not BLOCKED', () => {
  // Only 4 scored nights: below MIN_NIGHTS_TO_JUDGE_UNDERBUY (5) → fail-closed
  // to LEARNING rather than a trigger-happy BLOCK on noise.
  const rows = cleanLedger(4, (r) => {
    r.buy_err_kwh = -1;
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
});

/* ── prior-algo exclusion (§5.2) ──────────────────────────────────────── */

test('prior-algo_version rows are excluded, not counted', () => {
  // 100 current-algo clean rows (would be READY) + 50 prior-algo rows that all
  // floor-breached. The breaches must NOT block — they belong to a dead algo.
  const current = cleanLedger(100);
  const stale = cleanLedger(50, (r) => {
    r.algo_version = CURRENT_ALGO_VERSION - 1;
    r.plan_traj_floor_breached = 1;
  });
  const r = computeNightChargeReadiness([...stale, ...current], NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES', r.blocking.join(' | '));
  assert.equal(r.scoredDays, 100);
  assert.equal(r.metrics.floorBreaches, 0);
});

test('only prior-algo rows present → LEARNING (nothing eligible)', () => {
  const stale = cleanLedger(100, (r) => {
    r.algo_version = 0;
  });
  const r = computeNightChargeReadiness(stale, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.scoredDays, 0);
});

test('opts.algoVersion override selects a different generation', () => {
  const rows = cleanLedger(100, (r) => {
    r.algo_version = 7;
  });
  const r = computeNightChargeReadiness(rows, NOW, { algoVersion: 7 });
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES', r.blocking.join(' | '));
});

/* ── climatology rows never count toward eligibility (§5.1) ───────────── */

test('climatology weekend rows never count toward eligibility', () => {
  const forecast = cleanLedger(100);
  // Add climatology rows that floor-breached — excluded from the eligible set,
  // so they neither block nor pad the count.
  const clim = cleanLedger(40, (r) => {
    r.confidence_tier = 'climatology';
    r.plan_traj_floor_breached = 1;
  });
  const r = computeNightChargeReadiness([...clim, ...forecast], NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES', r.blocking.join(' | '));
  assert.equal(r.scoredDays, 100);
  assert.equal(r.metrics.floorBreaches, 0);
});

test('mixed-basis rows also do not count toward eligibility', () => {
  const rows = cleanLedger(100, (r) => {
    r.confidence_tier = 'mixed';
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.scoredDays, 0);
});

/* ── MNAR exclusion cap (§3.5) ────────────────────────────────────────── */

test('MNAR exclusion above cap blocks readiness', () => {
  // 100 eligible scored forecast nights + 120 outcome-captured-but-excluded
  // nights (scored=0) → exclusion 120/220 ≈ 55% > 35% cap.
  const scored = cleanLedger(100);
  const excluded = cleanLedger(120, (r, i) => {
    r.scored = 0;
    r.plan_date = '2027-' + String((i % 12) + 1).padStart(2, '0') + '-15';
  });
  const r = computeNightChargeReadiness([...scored, ...excluded], NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
  assert.ok((r.metrics.exclusionFrac as number) > 0.35);
  assert.ok(r.blocking.some((b) => /exclusion/.test(b)));
});

/* ── band over-coverage fails the UPPER bound ─────────────────────────── */

test('100% band coverage over-covers and fails the [78,92]% band', () => {
  const rows = cleanLedger(100, (r) => {
    r.pv_in_band = 1;
    r.load_in_band = 1;
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.metrics.bandCoveragePct, 100);
  assert.ok(r.blocking.some((b) => /band coverage/.test(b)));
});

/* ── autocorrelation-adjusted effectiveN (§5.2) ───────────────────────── */

test('highly autocorrelated residuals deflate effectiveN below the floor', () => {
  // A monotone ramp of PV residuals: raw n=100 but lag-1 autocorrelation ≈ 1,
  // so the effective independent sample collapses below MIN_EFFECTIVE_N.
  const rows = cleanLedger(100, (r, i) => {
    const v = (i / 99) * 0.1; // 0 … 0.10, mean ~0.05
    r.pv_err_frac = v;
    r.load_err_frac = v;
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.ok(r.effectiveN < 45, `effectiveN=${r.effectiveN}`);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => /effective-N/.test(b)));
});

/* ── biased forecast fails accuracy even when correlated ──────────────── */

test('gross over-buy bias fails the buy-bias band', () => {
  const rows = cleanLedger(100, (r) => {
    r.buy_err_kwh = 10; // way over the 5 kWh over-buy ceiling
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => /buy bias/.test(b)));
});

test('biased PV forecast fails normalized MAE/bias', () => {
  const rows = cleanLedger(100, (r) => {
    r.pv_err_frac = 0.3; // 30% biased-high — passes r² but not MAE/bias
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => /PV day-ahead/.test(b)));
});

/* ── young-but-full record still fails the in-season window (I13) ─────── */

test('enough nights but too-young a record → LEARNING (I13 in-season gate)', () => {
  // 100 nights, but all issued within the last ~40 days → span < 90d in-season.
  const rows: NightLedgerRow[] = [];
  for (let i = 0; i < 100; i++) {
    const issued = NOW - Math.floor((i / 100) * 40) * DAY_MS - DAY_MS; // 1..41 days ago
    rows.push(
      makeRow({
        plan_date: '2026-06-' + String((i % 28) + 1).padStart(2, '0'),
        issued_at_ms: issued,
        outcome_captured_at_ms: issued + DAY_MS,
        pv_err_frac: i % 2 ? 0.05 : -0.05,
        load_err_frac: i % 2 ? 0.05 : -0.05,
        pv_in_band: i % 20 < 17 ? 1 : 0,
        load_in_band: i % 20 < 17 ? 1 : 0,
      }),
    );
  }
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => /in-season/.test(b)));
});

/* ── metrics shape ────────────────────────────────────────────────────── */

test('metrics expose the frozen thresholds and computed sub-metrics', () => {
  const r: NightChargeReadiness = computeNightChargeReadiness(cleanLedger(100), NOW);
  assert.equal(r.metrics.requiredInSeasonDays, 90);
  assert.equal(r.metrics.minScoredEligibleDays, 60);
  assert.equal(r.metrics.minEffectiveN, 45);
  assert.equal(r.metrics.exclusionFrac, 0);
  assert.equal(r.metrics.forecastBasisPct, 100);
  assert.equal(typeof r.metrics.bandCoveragePct, 'number');
});


/* ── v1.38.0 whole-stack-review regressions ──────────────────────────────── */

test('regression — algo_version stored as SQLite TEXT "1" is COUNTED, not excluded (gate not inert)', () => {
  // The recorder persists algo_version as TEXT; the old numeric `asNum(...) ===
  // algoVersion` never matched a real "1", so currentAlgo was ALWAYS empty and
  // the gate was permanently stuck in LEARNING regardless of the record.
  const rows = cleanLedger(100).map((r) => ({ ...(r as any), algo_version: String(CURRENT_ALGO_VERSION) })) as unknown as NightLedgerRow[];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.ok(r.scoredDays > 0, 'TEXT-algo_version rows must be counted, not excluded');
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
});

test('regression — a floor breach on a COVERAGE-EXCLUDED (scored=0) forecast night still BLOCKS', () => {
  // §3.3 plan-trajectory breach is independent of grid_home_w coverage, so a
  // would-have-breached plan on a propped / low-coverage storm night — the exact
  // adverse night the gate exists to catch — must still block, not be ignored
  // because it fell out of the coverage-`scored` subset.
  const rows = cleanLedger(100, (r, i) => {
    if (i === 0) { r.plan_traj_floor_breached = 1; r.scored = 0; r.grid_home_coverage_frac = 0.4; }
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED', 'a breach on a coverage-excluded night must block');
  assert.equal(r.writeReady, false);
});
