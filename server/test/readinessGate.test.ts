import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.186.0 — the readiness gate was permanently BLOCKED by phantom engine-fault strikes.
 *
 * Since v1.125.0 `minProjSocPct` is the whole-house DISCLOSURE trough (~0% on a plant
 * whose pool is smaller than a day of whole-house load), while the cushion test judges
 * the islanded outage onset. The scorer kept grading `minProjSocPct` against the legacy
 * flat band, so every night whose plan held the cushion was stored as
 * plan_traj_floor_breached=1, the gate counted it as a strike, and the 14-night clear
 * streak could never start. These tests pin:
 *   - the plan carries the trough and line its cushion test used (every basis, hold too);
 *   - the scorer grades on them — legacy-pct unchanged, a genuine breach still true,
 *     rounding not a breach, a missing trough UNKNOWN (null), never "held";
 *   - the gate sets aside the pre-v1.186.0 disclosure-trough flags (counted, not hidden),
 *     still counts a sizing-trough breach, a NULL-disclosure row, and every REALIZED
 *     breach, and lets set-aside nights build the clear streak;
 *   - the two columns persist and index.ts writes and reconstructs them.
 */

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-readiness-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const {
  computeNightChargePlan, buildNightChargeInputs, scoreNightOutcome, PLAN_TRAJ_BREACH_TOLERANCE_PCT,
} = await import('../src/nightChargeAdvisor.js');
const { computeNightChargeReadiness, CURRENT_ALGO_VERSION, phoenixYmd } = await import('../src/nightChargeGate.js');
import type { NightChargePlan, NightOutcomeActuals } from '../src/nightChargeAdvisor.js';
import type { NightLedgerRow } from '../src/recorder.js';

// ── A live-shaped plant: 92.16 kWh pool, 16% floor, 15% legacy band, islanded 3.14 kW ──
const POOL = 92.16, H = 3_600_000, EVE = Date.UTC(2026, 8, 16, 4, 30);
const overnight = (ms: number): string | null => { const h = new Date(ms).getUTCHours(); return h >= 6 && h < 12 ? 'overnight' : 'other'; };
const plan = (over: Record<string, unknown> = {}): NightChargePlan => computeNightChargePlan(buildNightChargeInputs({
  gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 50, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
  legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, periodIdAt: overnight, cheapPeriodId: 'overnight', windowScanHours: 30,
  bandHours: Array.from({ length: 30 }, (_, i) => ({ ts: EVE + i * H, pvP10W: 0, loadP90W: 6500 })), dayRollups: [],
  realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null, ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
  calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9, morningPvSurplusP90Kwh: 32.6, minBuyKwh: 1, buyDebiasFactor: 1,
  islandedLoadKw: 3.14, outageCushionHours: 4, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90, ...over,
} as never));

const NO_ACTUALS: NightOutcomeActuals = {
  actualPvKwh: null, forecastPvKwh: null, actualLoadKwh: null, forecastLoadKwh: null,
  actualMinSocPct: null, actualMinSocTsMs: null, realizedNeedBuyKwh: null,
};
const verdict = (p: NightChargePlan | null) => scoreNightOutcome(p, NO_ACTUALS).planTrajFloorBreached;
/** The pre-v1.186.0 grading, to prove each scenario reproduces the defect. */
const oldVerdict = (p: NightChargePlan) => p.minProjSocPct! < p.reserveFloorPct + p.cushionPct - 1e-9;

// ── The plan carries the trough and line its cushion test used ─────────────────────

test('★★★ islanded basis, cost mode: the plan holds its line while the disclosure trough reads 0%', () => {
  const p = plan();
  assert.equal(p.cushionBasis, 'islanded-outage');
  assert.equal(p.objective, 'cost_arbitrage');
  assert.equal(p.cushionShortfall, false, 'the plan claims the cushion holds');
  assert.equal(p.minProjSocPct, 0, 'the whole-house disclosure trough — what the scorer used to grade');
  assert.equal(oldVerdict(p), true, 'precondition: the pre-v1.186.0 grading calls this night a breach');
  // The line is the floor plus the cushion AS APPLIED, not floor + the 15% legacy band.
  const applied = 16 + (p.cushionKwh! / POOL) * 100;
  assert.ok(Math.abs(p.cushionLineSocPct! - applied) < 0.02, `line ${p.cushionLineSocPct} ≈ ${applied}`);
  assert.ok(p.cushionLineSocPct! > 16 + 15 + 1, 'not the legacy flat band');
  assert.ok(p.cushionTroughSocPct! >= p.cushionLineSocPct! - PLAN_TRAJ_BREACH_TOLERANCE_PCT, 'sized to the line');
  assert.equal(verdict(p), false, '★ graded on the sizing trough the night held — no strike');
});

test('★★ a HOLD night carries its no-buy sizing trough, not the 0% disclosure figure', () => {
  const p = plan({ objectiveMode: 'resilience', socNowPct: 95 });
  assert.equal(p.objective, 'none');
  assert.equal(p.buyKwh, 0);
  assert.equal(p.cushionShortfall, false);
  assert.equal(p.minProjSocPct, 0);
  assert.equal(oldVerdict(p), true, 'precondition: a hold night was a phantom strike too');
  assert.ok(p.cushionTroughSocPct! > p.cushionLineSocPct!, `trough ${p.cushionTroughSocPct} clears line ${p.cushionLineSocPct}`);
  assert.ok(p.cushionTroughSocPct! > 30, 'the pack at window close, not the whole-house island');
  assert.equal(verdict(p), false);
});

test('★★ legacy-pct basis grades exactly as before: the sizing trough IS the whole-house trough', () => {
  const light = Array.from({ length: 30 }, (_, i) => ({ ts: EVE + i * H, pvP10W: 0, loadP90W: 1000 }));
  const held = plan({ islandedLoadKw: null, objectiveMode: 'resilience', bandHours: light });
  assert.equal(held.cushionBasis, 'legacy-pct');
  assert.equal(held.cushionLineSocPct, 31, 'floor + cushionPct');
  assert.ok(Math.abs(held.cushionTroughSocPct! - held.minProjSocPct!) <= 0.05, 'same trough, finer rounding');
  assert.equal(verdict(held), false);
  assert.equal(verdict(held), oldVerdict(held));
  // A legacy-basis night whose own trough cannot reach the line.
  const short = plan({ islandedLoadKw: null, objectiveMode: 'resilience' });
  assert.equal(short.cushionBasis, 'legacy-pct');
  assert.equal(short.cushionShortfall, true);
  assert.equal(verdict(short), true);
  assert.equal(verdict(short), oldVerdict(short));
});

test('★ a DISABLED cushion is tested against the reserve floor alone', () => {
  const p = plan({ outageCushionHours: 0 });
  assert.equal(p.cushionBasis, 'disabled');
  assert.equal(p.cushionLineSocPct, 16);
  assert.equal(p.cushionShortfall, false);
  assert.equal(verdict(p), false);
});

// ── The scorer ─────────────────────────────────────────────────────────────────────

test('★★★ a GENUINE engine fault still reads breached: the plan claims hold but its own sizing trough is under its line', () => {
  const p = plan();
  const lying: NightChargePlan = { ...p, cushionShortfall: false, cushionTroughSocPct: p.cushionLineSocPct! - 3 };
  assert.equal(verdict(lying), true);
  // A plan that honestly disclosed a shortfall also reads breached (the gate exempts it).
  const disclosed = plan({ objectiveMode: 'resilience', socNowPct: 5, chargeCapKw: 1 });
  assert.equal(disclosed.cushionShortfall, true);
  assert.equal(verdict(disclosed), true);
});

test('★★ rounding is not a breach: 0.01 %-pt under the line holds, 0.06 %-pt is a breach', () => {
  const p = plan();
  const line = p.cushionLineSocPct!;
  assert.equal(verdict({ ...p, cushionTroughSocPct: line }), false);
  assert.equal(verdict({ ...p, cushionTroughSocPct: Math.round((line - 0.01) * 100) / 100 }), false);
  assert.equal(verdict({ ...p, cushionTroughSocPct: Math.round((line - 0.06) * 100) / 100 }), true);
});

test('★★★ a plan without its sizing trough (issued before v1.186.0) is UNKNOWN — never graded on the disclosure trough', () => {
  const p = plan();
  // Exactly what index.ts reconstructs from a pre-v1.186.0 ledger row.
  const legacyRow: NightChargePlan = { ...p, cushionTroughSocPct: null, cushionLineSocPct: null };
  assert.equal(legacyRow.minProjSocPct, 0);
  assert.strictEqual(verdict(legacyRow), null);
  const { cushionTroughSocPct: _t, cushionLineSocPct: _l, ...absent } = p;
  assert.strictEqual(verdict(absent as NightChargePlan), null, 'absent fields read as unknown too');
  assert.strictEqual(verdict({ ...p, cushionLineSocPct: null }), null, 'a trough without its line cannot be graded');
  assert.strictEqual(verdict(null), null);
});

// ── The gate ───────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 4, 30); // 21:30 Phoenix, 2026-09-24
const ago = (d: number) => phoenixYmd(NOW - d * DAY);
const dayOf = (ymd: string) => Math.round((NOW - Date.parse(`${ymd}T12:00:00Z`)) / DAY);

function row(plan_date: string, f: Record<string, unknown> = {}): NightLedgerRow {
  return {
    plan_date, algo_version: String(CURRENT_ALGO_VERSION), confidence_tier: 'forecast',
    issued_at_ms: NOW - dayOf(plan_date) * DAY, outcome_captured_at_ms: NOW - (dayOf(plan_date) - 1) * DAY,
    scored: 1, actuated: 1, cushion_shortfall: 1, plan_traj_floor_breached: 1, cushion_breached: 0,
    min_proj_soc_pct: 0, actual_min_soc_pct: 45, buy_err_kwh: 20,
    pv_err_frac: 0.05, load_err_frac: -0.1, pv_in_band: 1, load_in_band: 1, grid_home_coverage_frac: 0.97,
    cushion_trough_soc_pct: null, cushion_line_soc_pct: null,
    ...f,
  } as unknown as NightLedgerRow;
}
/** The pre-v1.186.0 disclosure-trough shape: plan claimed hold, stored flag breached,
 *  cushion never breached, no sizing trough recorded. */
const PHANTOM = { cushion_shortfall: 0, plan_traj_floor_breached: 1, cushion_breached: 0, min_proj_soc_pct: 0 };

/** The live ledger as captured 2026-09-24: 22 actuated nights, 19 of them disclosed
 *  shortfalls; four phantom strikes (three actuated, one advisory); 09-23 not yet scored. */
function liveLedger(): NightLedgerRow[] {
  const rows: NightLedgerRow[] = [];
  for (let d = 25; d >= 8; d--) rows.push(row(ago(d))); // 18 actuated disclosed-shortfall nights
  rows.push(
    row('2026-09-17', { ...PHANTOM, actual_min_soc_pct: 73, buy_err_kwh: 21.9 }),
    row('2026-09-18', { cushion_shortfall: 1, actuated: null, actual_min_soc_pct: 42 }),
    row('2026-09-19', { ...PHANTOM, actuated: null, actual_min_soc_pct: 74 }),
    row('2026-09-20', { cushion_shortfall: 1, actual_min_soc_pct: 74 }),
    row('2026-09-21', { ...PHANTOM, actual_min_soc_pct: 60, buy_err_kwh: 23.1 }),
    row('2026-09-22', { ...PHANTOM, actual_min_soc_pct: 60, buy_err_kwh: 23.1 }),
    row('2026-09-23', { cushion_shortfall: 0, plan_traj_floor_breached: null, cushion_breached: null, outcome_captured_at_ms: null, scored: null }),
  );
  return rows;
}

test('★★★ the live ledger: the four phantom strikes stop counting, and the REAL blockers surface', () => {
  const rows = liveLedger();
  assert.equal(rows.filter((r) => r.actuated === 1 && r.scored === 1).length, 22, 'fixture matches the live count');
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.metrics.activeStrikes, 0);
  assert.equal(r.metrics.trajStrikesSetAside, 4, 'set aside, and SAID so — never dropped silently');
  assert.notEqual(r.state, 'BLOCKED');
  assert.equal(r.state, 'LEARNING', 'fail-closed: the other criteria still fail');
  assert.equal(r.writeReady, false);
  assert.ok(!r.blocking.some((b) => b.includes('engine-fault')), r.blocking.join(' | '));
  assert.ok(r.blocking.some((b) => b.includes('delivery bias')), 'the 22.7 kWh bias the false block used to hide');
  assert.ok(r.blocking.some((b) => b.includes('band coverage')));
});

test('★★★ the same nights graded on a SIZING trough under the line are strikes — the detector still fires', () => {
  const rows = liveLedger().map((x) => (x.cushion_shortfall === 0 && x.plan_traj_floor_breached === 1
    ? { ...x, cushion_trough_soc_pct: 20, cushion_line_soc_pct: 34.12 } as NightLedgerRow : x));
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.metrics.activeStrikes, 4);
  assert.equal(r.metrics.trajStrikesSetAside, 0);
  assert.ok(r.blocking.some((b) => b.includes('engine-fault')));
});

test('★★★ a REALIZED breach on a set-aside night is still a strike', () => {
  const rows = [...liveLedger(), row(ago(1), { ...PHANTOM, cushion_breached: 1, actual_min_soc_pct: 22 })];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.metrics.activeStrikes, 1);
});

test('★★ a NULL-disclosure row keeps counting its stored flag (fail-closed, unchanged)', () => {
  const rows = [...liveLedger(), row(ago(1), { cushion_shortfall: null, plan_traj_floor_breached: 1, actuated: 0 })];
  const r = computeNightChargeReadiness(rows, NOW);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.metrics.activeStrikes, 1);
});

test('★★ set-aside nights are strike-free evidence: they build the clear streak after a genuine strike', () => {
  const genuine = row(ago(20), { cushion_shortfall: 0, cushion_trough_soc_pct: 20, cushion_line_soc_pct: 34.12, actuated: 0 });
  const after: NightLedgerRow[] = [];
  for (let d = 19; d >= 1; d--) after.push(row(ago(d), { ...PHANTOM, buy_err_kwh: 1 }));
  const r = computeNightChargeReadiness([genuine, ...after], NOW);
  assert.equal(r.metrics.strikeFreeStreak, 19);
  assert.equal(r.metrics.strikesCleared, 1);
  assert.equal(r.metrics.activeStrikes, 0);
  assert.equal(r.metrics.trajStrikesSetAside, 19);
});

test('★ the set-aside count covers the strike window only', () => {
  const r = computeNightChargeReadiness([...liveLedger(), row(ago(60), PHANTOM)], NOW);
  assert.equal(r.metrics.trajStrikesSetAside, 4);
});

test('★★★ end to end: a live-shaped plan → its ledger columns → the scorer → the gate raises no strike', () => {
  const p = plan();
  // What recordNightPlanRow writes, and what the scorer reconstructs from it.
  const planCols = { cushion_shortfall: p.cushionShortfall ? 1 : 0, cushion_trough_soc_pct: p.cushionTroughSocPct ?? null, cushion_line_soc_pct: p.cushionLineSocPct ?? null };
  const reconstructed = { ...p, cushionTroughSocPct: planCols.cushion_trough_soc_pct, cushionLineSocPct: planCols.cushion_line_soc_pct };
  const v = verdict(reconstructed);
  assert.equal(v, false);
  const nights: NightLedgerRow[] = [];
  for (let d = 25; d >= 1; d--) nights.push(row(ago(d), { ...planCols, plan_traj_floor_breached: v ? 1 : 0, buy_err_kwh: 1 }));
  const r = computeNightChargeReadiness(nights, NOW);
  assert.equal(r.metrics.activeStrikes, 0);
  assert.equal(r.metrics.trajStrikesSetAside, 0);
});

// ── Persistence ────────────────────────────────────────────────────────────────────

test('★★★ both columns round-trip (a column missing from the allowlist or the ALTER drops writes SILENTLY)', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'cost_arbitrage', rationale: 'x',
      confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 50, target_soc_pct: 64.6, buy_kwh: 36.45, required_extra_kwh: 19.98,
      reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 16.7, binding_cap: 'requirement', cushion_shortfall: 0 });
    rec.recordNightPlan({ ...base('2026-09-24'), cushion_trough_soc_pct: 34.12, cushion_line_soc_pct: 34.12 } as never);
    rec.recordNightPlan(base('2026-09-22') as never); // a pre-v1.186.0 row
    const at = (d: string) => rec.readNightLedger(3650).find((r) => r.plan_date === d) as unknown as Record<string, unknown>;
    assert.deepEqual([at('2026-09-24').cushion_trough_soc_pct, at('2026-09-24').cushion_line_soc_pct], [34.12, 34.12]);
    for (const c of ['cushion_trough_soc_pct', 'cushion_line_soc_pct']) {
      assert.ok(c in at('2026-09-22'), `${c} exists on the read row`);
      assert.equal(at('2026-09-22')[c], null, `${c} is null on an older row, never fabricated`);
    }
    // An OUTCOME write never clobbers the frozen plan columns.
    rec.recordNightOutcome('2026-09-24', { outcome_captured_at_ms: 2, plan_traj_floor_breached: 0 });
    assert.equal(at('2026-09-24').cushion_trough_soc_pct, 34.12);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('★★ SOURCE PIN: index.ts writes both columns UNCONDITIONALLY and reconstructs them for the scorer', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  const fn = src.indexOf('function recordNightPlanRow(');
  const guard = src.indexOf('if (plan.minProjSocPct != null) {', fn);
  assert.ok(fn > 0 && guard > fn);
  for (const l of ['cushion_trough_soc_pct: plan.cushionTroughSocPct ?? null,', 'cushion_line_soc_pct: plan.cushionLineSocPct ?? null,']) {
    const at = src.indexOf(l, fn);
    assert.ok(at > fn && at < guard, `${l} is in recordNightPlanRow, outside the minProjSocPct guard`);
  }
  const score = src.indexOf('const score = scoreNightOutcome(yPlan, actuals);');
  for (const l of ['cushionTroughSocPct: y.cushion_trough_soc_pct ?? null,', 'cushionLineSocPct: y.cushion_line_soc_pct ?? null,']) {
    const at = src.indexOf(l);
    assert.ok(at > 0 && at < score, `${l} is in the scorer's plan reconstruction`);
  }
});
