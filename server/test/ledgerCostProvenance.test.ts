import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** v1.174.0 — the ledger persists WHICH surplus set the cost ceiling, whether the long-gap
 *  rule did, the ceiling itself, and the panel's age (v1.168.0 follow-up #8). */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-prov-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { computeNightChargePlan, buildNightChargeInputs } = await import('../src/nightChargeAdvisor.js');

const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'cost_arbitrage', rationale: 'x',
  confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 50, target_soc_pct: 90, buy_kwh: 30, required_extra_kwh: 0,
  reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 23.8, binding_cap: 'requirement' });

test('★★★ the four columns round-trip (a column missing from the allowlist or the ALTER drops writes SILENTLY)', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightPlan({ ...base('2026-09-17'), cost_surplus_basis: 'none', cost_long_gap: 1, cost_ceiling_soc_pct: 90, panel_sample_age_s: 312 } as never);
    rec.recordNightPlan({ ...base('2026-09-16'), cost_surplus_basis: 'p50', cost_long_gap: 0, cost_ceiling_soc_pct: 82.6, panel_sample_age_s: 14 } as never);
    rec.recordNightPlan(base('2026-09-10') as never); // a pre-v1.174.0 row
    const at = (d: string) => rec.readNightLedger(3650).find((r: any) => r.plan_date === d) as any;
    assert.deepEqual([at('2026-09-17').cost_surplus_basis, at('2026-09-17').cost_long_gap, at('2026-09-17').cost_ceiling_soc_pct, at('2026-09-17').panel_sample_age_s], ['none', 1, 90, 312]);
    assert.deepEqual([at('2026-09-16').cost_surplus_basis, at('2026-09-16').cost_long_gap], ['p50', 0]);
    for (const c of ['cost_surplus_basis', 'cost_long_gap', 'cost_ceiling_soc_pct', 'panel_sample_age_s']) {
      assert.ok(c in at('2026-09-10'), `${c} exists on the read row`);
      assert.equal(at('2026-09-10')[c], null, `${c} is null on an older row, never fabricated`);
    }
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});

const POOL = 92.16, H = 3_600_000, EVE = Date.UTC(2026, 8, 16, 4, 30);
const overnight = (ms: number): string | null => { const h = new Date(ms).getUTCHours(); return h >= 6 && h < 12 ? 'overnight' : 'other'; };
const plan = (over: Record<string, unknown> = {}): any => computeNightChargePlan(buildNightChargeInputs({
  gridInputCapKw: null, nowMs: EVE, fullKwh: POOL, socNowPct: 20, reserveFloorPct: 16, cushionPct: 15, socCoherent: true,
  legEff: 0.927, dischargeEff: 0.94, chargeCapKw: 7.2, periodIdAt: overnight, cheapPeriodId: 'overnight', windowScanHours: 30,
  bandHours: Array.from({ length: 30 }, (_, i) => ({ ts: EVE + i * H, pvP10W: 0, loadP90W: 1500 })), dayRollups: [],
  realizedDailyErrHalfFrac: 0.1, nextRechargeMs: null, ev: null, evMaxLoadW: 11520, confidenceTier: 'forecast', forecastPresent: true,
  calScoredDays: 30, minCalScoredDays: 7, bandCoverageFrac: 0.9, morningPvSurplusP90Kwh: 32.6, minBuyKwh: 1, buyDebiasFactor: 1,
  islandedLoadKw: 4.47, outageCushionHours: 4, islandedLoadSafety: 1.25, objectiveMode: 'cost', costMaxSocPct: 90, ...over,
} as never));

test('★★★ the plan names the surplus basis: median, P90 stand-in, or none', () => {
  assert.equal(plan({ morningPvSurplusP50Kwh: 16 }).costCeilingSurplusBasis, 'p50');
  assert.equal(plan({ morningPvSurplusP50Kwh: null }).costCeilingSurplusBasis, 'p90');
  const thu = plan({ morningPvSurplusP50Kwh: 16, longGapAhead: true });
  assert.equal(thu.costCeilingSurplusBasis, 'none');
  assert.equal(thu.longGapAhead, true, 'set aside by the rule — the long-gap flag tells it from "unknown"');
  const blind = plan({ morningPvSurplusP90Kwh: null, morningPvSurplusP50Kwh: null });
  assert.equal(blind.costCeilingSurplusBasis, 'none');
  assert.equal(blind.longGapAhead, false);
  assert.equal(plan({ objectiveMode: 'resilience' }).costCeilingSurplusBasis ?? null, null);
});

test('★★ a cost-mode HOLD carries its provenance too (the ledger shows cost mode was asked)', () => {
  const h = plan({ socNowPct: 100, morningPvSurplusP50Kwh: 40 });
  assert.equal(h.chargeTonight, false);
  assert.equal(h.costCeilingSurplusBasis, 'p50');
  assert.equal(h.longGapAhead, false);
});

test('★★ SOURCE PIN: recordNightPlanRow maps all four', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
  for (const l of [
    'cost_surplus_basis: plan.costCeilingSurplusBasis ?? null,',
    'cost_long_gap: plan.longGapAhead == null ? null : (plan.longGapAhead ? 1 : 0),',
    'cost_ceiling_soc_pct: plan.costCeilingSocPct ?? null,',
    'panel_sample_age_s: extras.panelSampleAgeS ?? null,',
  ]) assert.ok(src.includes(l), l);
});
