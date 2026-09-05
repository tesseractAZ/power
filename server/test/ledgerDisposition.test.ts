import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.132.0 — the two ledger columns that make a night's outcome legible.
 *
 * `actuated` alone is over-loaded: NULL covers at least five dispositions
 * (superseded by a later plan, held below the minimum buy, no window resolved,
 * advisory mode, apply guards refused). The 2026-08-29 row sat at
 * actuated=NULL with buy_kwh=36 and read like a failed 36 kWh buy when it was a
 * routine Sat/Sun shared-window supersede — recorded in a log line, nowhere in
 * the ledger.
 *
 * `objective` is likewise not evidence about cost mode: it records the
 * CONFIGURED mode plus buy/no-buy. costModeTargetKwh floors at the resilience
 * answer and raises only under a strict inequality, so a row labelled
 * 'cost_arbitrage' can carry zero cost-mode contribution. `cost_ceiling_basis`
 * is the field that discriminates, and it was computed and thrown away.
 *
 * A column is only real when the DDL, the write allowlist and the row type ALL
 * carry it — a mismatch drops writes silently, which is exactly the failure
 * mode this release exists to remove.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-disp-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
import type { NightLedgerRow } from '../src/recorder.js';

const PLAN_DATE = '2026-08-29';

function planRow(): Partial<NightLedgerRow> & { plan_date: string } {
  return {
    plan_date: PLAN_DATE,
    issued_at_ms: 1_756_500_000_000,
    algo_version: 'nc-v1',
    posture: 'supervised',
    objective: 'cost_arbitrage',
    rationale: 'Buy ~36 kWh overnight.',
    confidence_tier: 'forecast',
    horizon_hours: 30,
    soc_now_pct: 30,
    target_soc_pct: 66,
    buy_kwh: 36,
    required_extra_kwh: 33.4,
    reserve_floor_pct: 16,
    cushion_pct: 15,
    cushion_kwh: 23.2,
    binding_cap: 'requirement',
  };
}

test('THE MEASURED ROW: a superseded arm is no longer indistinguishable from a failure', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightOutcome(PLAN_DATE, planRow());
    // Nothing actuated: on the old schema this row was actuated=NULL with a
    // 36 kWh buy and no way to tell why.
    const before = rec.readNightLedger(3650).find((r) => r.plan_date === PLAN_DATE)!;
    assert.equal(before.actuated, null, 'premise: no actuation row');
    assert.equal(before.arm_disposition, null, 'and no explanation yet');

    rec.recordNightOutcome(PLAN_DATE, {
      arm_disposition: 'superseded by the 2026-08-30 plan — Sat/Sun share one Monday window, so only the later arm writes',
    });
    const after = rec.readNightLedger(3650).find((r) => r.plan_date === PLAN_DATE)!;
    assert.match(String(after.arm_disposition), /superseded by the 2026-08-30 plan/);
    assert.equal(after.actuated, null, 'the disposition explains the null, it does not fabricate an actuation');
    assert.equal(after.buy_kwh, 36, 'and the frozen PLAN columns survive the merge');
  } finally {
    rec.close();
  }
});

test('cost_ceiling_basis round-trips, so cost mode becomes auditable', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightOutcome('2026-09-01', { ...planRow(), plan_date: '2026-09-01', cost_ceiling_basis: 'max-soc' });
    rec.recordNightOutcome('2026-09-02', { ...planRow(), plan_date: '2026-09-02', cost_ceiling_basis: 'pv-headroom' });
    // A cost_arbitrage row with NO ceiling basis is the honest "cost mode was
    // labelled but contributed nothing" case, and must stay distinguishable.
    rec.recordNightOutcome('2026-09-03', { ...planRow(), plan_date: '2026-09-03' });
    const rows = rec.readNightLedger(3650);
    const at = (d: string) => rows.find((r) => r.plan_date === d)!;
    assert.equal(at('2026-09-01').cost_ceiling_basis, 'max-soc');
    assert.equal(at('2026-09-02').cost_ceiling_basis, 'pv-headroom');
    assert.equal(at('2026-09-03').cost_ceiling_basis, null);
    // All three carry the same objective — which is precisely why objective
    // cannot answer the question and this column can.
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      assert.equal(at(d).objective, 'cost_arbitrage', d);
    }
  } finally {
    rec.close();
  }
});

test('★ a column absent from the DDL or the allowlist would drop writes SILENTLY', () => {
  // The whole point: recordNightOutcome does not throw on an unknown column, it
  // ignores it. So the only proof a column is real is a round-trip.
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightOutcome('2026-09-04', {
      ...planRow(),
      plan_date: '2026-09-04',
      arm_disposition: 'held — below minimum buy',
      cost_ceiling_basis: 'pv-headroom',
    });
    const row = rec.readNightLedger(3650).find((r) => r.plan_date === '2026-09-04')!;
    assert.equal(row.arm_disposition, 'held — below minimum buy');
    assert.equal(row.cost_ceiling_basis, 'pv-headroom');
    assert.ok('arm_disposition' in row && 'cost_ceiling_basis' in row, 'both columns exist on the read row');
  } finally {
    rec.close();
  }
});

test('rows written before v1.132.0 read null on both, never a fabricated value', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    rec.recordNightOutcome('2026-07-01', { ...planRow(), plan_date: '2026-07-01' });
    const row = rec.readNightLedger(3650).find((r) => r.plan_date === '2026-07-01')!;
    assert.equal(row.arm_disposition, null);
    assert.equal(row.cost_ceiling_basis, null);
  } finally {
    rec.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
