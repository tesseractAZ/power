import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** v1.187.1 (review) — the night ledger records the cost ceiling's surplus, used and raw, and the
 *  load factor and ledger nights behind the difference. Without them a row's
 *  cost_ceiling_soc_pct cannot say whether a 72% ceiling was de-biased, nor what the raw
 *  ceiling would have been, and the de-bias cannot be audited after the fact. */
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-surplus-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const base = (d: string) => ({ plan_date: d, issued_at_ms: 1, algo_version: '3', posture: 'auto', objective: 'cost_arbitrage', rationale: 'x',
  confidence_tier: 'forecast', horizon_hours: 30, soc_now_pct: 74, target_soc_pct: 72.8, buy_kwh: 11.5, required_extra_kwh: 0,
  reserve_floor_pct: 16, cushion_pct: 15, cushion_kwh: 13.3, binding_cap: 'requirement', cost_surplus_basis: 'p50', cost_ceiling_soc_pct: 72.8 });

const COLS = ['cost_surplus_kwh', 'cost_surplus_raw_kwh', 'cost_surplus_load_factor', 'cost_surplus_load_samples'] as const;

test('★★★ the four columns round-trip (a column missing from the allowlist or the ALTER drops writes SILENTLY)', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightPlan({ ...base('2026-09-29'), cost_surplus_kwh: 25.08, cost_surplus_raw_kwh: 20.54, cost_surplus_load_factor: 0.793, cost_surplus_load_samples: 6 } as never);
    rec.recordNightPlan({ ...base('2026-09-28'), cost_surplus_kwh: 20.54, cost_surplus_raw_kwh: 20.54, cost_surplus_load_factor: null, cost_surplus_load_samples: null } as never);
    rec.recordNightPlan(base('2026-09-22') as never); // a pre-v1.187.1 row
    const at = (d: string) => rec.readNightLedger(3650).find((r: any) => r.plan_date === d) as any;
    assert.deepEqual(COLS.map((c) => at('2026-09-29')[c]), [25.08, 20.54, 0.793, 6]);
    assert.deepEqual(COLS.map((c) => at('2026-09-28')[c]), [20.54, 20.54, null, null]);
    for (const c of COLS) {
      assert.ok(c in at('2026-09-22'), `${c} exists on the read row`);
      assert.equal(at('2026-09-22')[c], null, `${c} is null on an older row, never fabricated`);
    }
    // A re-issued plan of record replaces the figures; it never leaves the earlier plan's beside its own.
    rec.recordNightPlan({ ...base('2026-09-29'), cost_surplus_kwh: 20.54, cost_surplus_raw_kwh: 20.54, cost_surplus_load_factor: null, cost_surplus_load_samples: null } as never);
    assert.deepEqual(COLS.map((c) => at('2026-09-29')[c]), [20.54, 20.54, null, null]);
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});
