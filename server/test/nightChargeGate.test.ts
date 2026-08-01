import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNightChargeReadiness,
  nightChargeGateFields,
  getLatestReadiness,
  setLatestReadiness,
  CURRENT_ALGO_VERSION,
  phoenixYmd,
  type NightChargeReadiness,
} from '../src/nightChargeGate.js';
import type { NightLedgerRow } from '../src/recorder.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * nightChargeGate — write-readiness gate v2 (§5 as amended 2026-07-31).
 *
 * The gate is a PURE reduction over the night_charge_ledger; the evidence base
 * is ACTUATED nights. These tests pin the fail-CLOSED behaviour:
 *   - empty/thin record → LEARNING, writeReady strictly false
 *   - engine-fault strikes (claimed hold + breach) → BLOCKED
 *   - cushionShortfall-disclosed breaches are EXEMPT (physics, not fault)
 *   - a NULL cushion_shortfall still counts as "claimed hold" (fail-closed)
 *   - strikes age out of the 45-day window and clear on a 14-night
 *     strike-free actuated streak — but not one night early
 *   - under-buy over 10% with a judgeable sample → BLOCKED
 *   - the five graduation criteria → READY_TO_CONSIDER_WRITES
 *   - prior-algo rows (the v1 record incl. its strikes) are EXCLUDED
 *   - null readiness → write_ready strictly false
 * ═════════════════════════════════════════════════════════════════════════ */

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 17, 4, 30); // ~21:30 Phoenix on 2026-07-16 evening

/** plan_date `daysAgo` Phoenix days before NOW. */
function dateAgo(daysAgo: number): string {
  return phoenixYmd(NOW - daysAgo * DAY_MS);
}

/** One ledger row with clean, READY-contributing defaults; override any field.
 *  Cast through unknown — the gate reads only the subset set here. */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): NightLedgerRow {
  const base: Record<string, unknown> = {
    plan_date: dateAgo(10),
    algo_version: CURRENT_ALGO_VERSION,
    issued_at_ms: NOW - 10 * DAY_MS,
    confidence_tier: 'forecast',
    outcome_captured_at_ms: NOW - 9 * DAY_MS,
    scored: 1,
    actuated: 1,
    cushion_shortfall: 0,
    plan_traj_floor_breached: 0,
    cushion_breached: 0,
    buy_err_kwh: 0.5, // slight over-buy — the safe side
    pv_err_frac: 0.05,
    load_err_frac: 0.05,
    pv_in_band: 1,
    load_in_band: 1,
    grid_home_coverage_frac: 0.95,
  };
  return { ...base, ...overrides } as unknown as NightLedgerRow;
}

/**
 * A READY-worthy actuated ledger of `n` nights ending yesterday: alternating
 * residuals (low autocorrelation), band coverage held at ~85% (inside
 * [78%, 92%] — an all-in-band ledger would over-cover at 100% and fail the
 * upper bound), slight over-buy on every night.
 */
function actuatedLedger(n: number, mut?: (r: Record<string, unknown>, i: number) => void): NightLedgerRow[] {
  const rows: NightLedgerRow[] = [];
  for (let i = 0; i < n; i++) {
    const daysAgo = n - i; // i=0 oldest
    const inBand = i % 20 < 17 ? 1 : 0; // 85% joint coverage
    const r: Record<string, unknown> = {
      plan_date: dateAgo(daysAgo),
      algo_version: CURRENT_ALGO_VERSION,
      issued_at_ms: NOW - daysAgo * DAY_MS,
      confidence_tier: 'forecast',
      outcome_captured_at_ms: NOW - (daysAgo - 1) * DAY_MS,
      scored: 1,
      actuated: 1,
      cushion_shortfall: 0,
      plan_traj_floor_breached: 0,
      cushion_breached: 0,
      buy_err_kwh: 0.5,
      pv_err_frac: i % 2 ? 0.05 : -0.05,
      load_err_frac: i % 2 ? 0.05 : -0.05,
      pv_in_band: inBand,
      load_in_band: inBand,
      grid_home_coverage_frac: 0.95,
    };
    mut?.(r, i);
    rows.push(r as unknown as NightLedgerRow);
  }
  return rows;
}

// ── Fail-closed basics ──────────────────────────────────────────────────────

test('empty ledger → LEARNING, writeReady false', () => {
  const r = computeNightChargeReadiness([], NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
  assert.equal(r.scoredDays, 0);
  assert.ok(r.blocking.length > 0);
});

test('non-array input → LEARNING (defensive)', () => {
  const r = computeNightChargeReadiness(null as unknown as NightLedgerRow[], NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.writeReady, false);
});

test('captured but NON-actuated nights contribute forecast metrics, not scoredDays', () => {
  // 30 captured forecast nights, none actuated: coverage/accuracy computable,
  // but the graduation night-count stays 0 → LEARNING.
  const rows = actuatedLedger(30, (r) => { r.actuated = 0; });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.equal(r.scoredDays, 0);
  assert.equal(r.metrics.coverageNights, 30);
  assert.ok(r.blocking.some((b) => b.includes('actuated night')));
});

// ── Graduation (READY) ──────────────────────────────────────────────────────

test('25 clean actuated nights → READY_TO_CONSIDER_WRITES', () => {
  const r = computeNightChargeReadiness(actuatedLedger(25), NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
  assert.equal(r.writeReady, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.scoredDays, 25);
});

test('20 actuated nights (one short of 21) → LEARNING', () => {
  const r = computeNightChargeReadiness(actuatedLedger(20), NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => b.includes('need ≥ 21')));
});

test('delivery bias above 5 kWh (gross over-buy) → LEARNING', () => {
  const rows = actuatedLedger(25, (r) => { r.buy_err_kwh = 7; });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => b.includes('delivery bias')));
});

test('100% band coverage over-covers the [78, 92] band → LEARNING', () => {
  const rows = actuatedLedger(25, (r) => { r.pv_in_band = 1; r.load_in_band = 1; });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => b.includes('band coverage')));
});

test('fewer than 14 coverage-judgeable nights → LEARNING on coverage sample', () => {
  // 25 actuated nights but band verdicts recorded on only 10 of them.
  const rows = actuatedLedger(25, (r, i) => {
    if (i >= 10) { r.pv_in_band = null; r.load_in_band = null; }
  });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
  assert.ok(r.blocking.some((b) => b.includes('captured forecast night')));
});

// ── Under-buy (HARD) ────────────────────────────────────────────────────────

test('under-buy over 10% with a judgeable sample → BLOCKED', () => {
  // 10 actuated nights, 2 under-bought (20% > 10%).
  const rows = actuatedLedger(10, (r, i) => { if (i < 2) r.buy_err_kwh = -1.5; });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.writeReady, false);
  assert.ok(r.blocking.some((b) => b.includes('under-buy')));
});

test('under-buy on a sub-judgeable sample (<5 nights) → LEARNING, not BLOCKED', () => {
  const rows = actuatedLedger(3, (r, i) => { if (i === 0) r.buy_err_kwh = -2; });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'LEARNING');
});

// ── Engine-fault strikes (v2 semantics) ─────────────────────────────────────

test('trajectory breach with claimed hold → BLOCKED', () => {
  const rows = [...actuatedLedger(25), makeRow({ plan_date: dateAgo(5), plan_traj_floor_breached: 1, actuated: 0, scored: 0 })];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.ok(r.blocking.some((b) => b.includes('engine-fault')));
});

test('cushionShortfall-disclosed breach is EXEMPT (physics, not fault)', () => {
  const rows = [
    ...actuatedLedger(25),
    makeRow({ plan_date: dateAgo(5), plan_traj_floor_breached: 1, cushion_shortfall: 1, actuated: 0, scored: 0 }),
  ];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
});

test('NULL cushion_shortfall counts as claimed hold (fail-closed) → strike', () => {
  const rows = [
    ...actuatedLedger(25),
    makeRow({ plan_date: dateAgo(5), plan_traj_floor_breached: 1, cushion_shortfall: null, actuated: 0, scored: 0 }),
  ];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
});

test('actuated night with a REALIZED cushion breach (claimed hold) → strike, any tier', () => {
  const rows = [
    ...actuatedLedger(25),
    makeRow({ plan_date: dateAgo(4), confidence_tier: 'mixed', actuated: 1, cushion_breached: 1, buy_err_kwh: null }),
  ];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
});

test('strike older than the 45-day window is inactive', () => {
  const rows = [...actuatedLedger(25), makeRow({ plan_date: dateAgo(60), plan_traj_floor_breached: 1, actuated: 0, scored: 0 })];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
  assert.equal(r.metrics.activeStrikes, 0);
});

test('in-window strike clears after ≥14 consecutive strike-free actuated nights', () => {
  // Strike 20 days ago; actuatedLedger(40) has nights on days 40..1 → 19
  // strike-free actuated nights after it.
  const rows = [
    ...actuatedLedger(40),
    makeRow({ plan_date: dateAgo(20), plan_traj_floor_breached: 1, actuated: 0, scored: 0 }),
  ];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.metrics.activeStrikes, 0);
  assert.equal(r.metrics.strikesCleared, 1);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
});

test('13 strike-free actuated nights do NOT clear the strike', () => {
  // Strike 14 days ago; nights on days 40..1 → 13 nights strictly after it.
  const rows = [
    ...actuatedLedger(40),
    makeRow({ plan_date: dateAgo(14), plan_traj_floor_breached: 1, actuated: 0, scored: 0 }),
  ];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.metrics.strikeFreeStreak, 13);
});

// ── Algo-version exclusion ──────────────────────────────────────────────────

test('prior-algo rows (incl. their strikes) are EXCLUDED under v2', () => {
  const v1Strikes = actuatedLedger(30, (r) => {
    r.algo_version = '1';
    r.plan_traj_floor_breached = 1; // the permanent v1 strikes
  });
  const r = computeNightChargeReadiness([...v1Strikes, ...actuatedLedger(25)], NOW);
  assert.equal(r.state, 'READY_TO_CONSIDER_WRITES');
  assert.equal(r.scoredDays, 25);
});

test('algo_version stored as TEXT still matches (string compare)', () => {
  const rows = actuatedLedger(25, (r) => { r.algo_version = String(CURRENT_ALGO_VERSION); });
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.scoredDays, 25);
});

// ── Delivery surfaces ───────────────────────────────────────────────────────

test('nightChargeGateFields: null readiness → write_ready strictly false, all null', () => {
  const f = nightChargeGateFields(null);
  assert.equal(f.night_charge_readiness, 'unknown');
  assert.equal(f.night_charge_write_ready, false);
  assert.equal(f.night_charge_plan_nights_scored, null);
});

test('nightChargeGateFields: READY readiness round-trips', () => {
  const r = computeNightChargeReadiness(actuatedLedger(25), NOW);
  const f = nightChargeGateFields(r);
  assert.equal(f.night_charge_readiness, 'READY_TO_CONSIDER_WRITES');
  assert.equal(f.night_charge_write_ready, true);
  assert.equal(f.night_charge_plan_nights_scored, 25);
});

test('latest-readiness holder get/set round-trips', () => {
  const r: NightChargeReadiness = computeNightChargeReadiness([], NOW);
  setLatestReadiness(r);
  assert.equal(getLatestReadiness(), r);
});
